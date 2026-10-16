"""The Blender side: turns scene descriptions into a persistent Cycles scene and renders views.

Runs only inside the worker process, which owns ``bpy``. The scene is kept in the browser's
coordinate frame (three.js, Y up); only the sky lookup is rotated into Blender's Z-up convention.
Every light and emission unit below was calibrated against the browser's path tracer
(three-gpu-pathtracer): emission and sky radiance carry over as is, a sun's strength is its
irradiance, point and spot lights emit 4π W per W/sr of intensity, and area lights emit
π·area W per unit of radiance.

Data blocks are cached by content (meshes by geometry hash, images by file hash, materials by
their parameters), and Cycles keeps its scene between renders (persistent data), so a new camera
angle re-renders without re-syncing anything, and an edit re-syncs only what it touched.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import time
from typing import Callable

import bpy
import numpy as np
from mathutils import Matrix, Vector

from .protocol import (
    ProtocolError,
    pack_image,
    parse_environment,
    parse_geometry,
    parse_instances,
)

FRONT_SIDE, BACK_SIDE, DOUBLE_SIDE = 0, 1, 2
# Data blocks unused for this many renders are freed.
EVICT_AFTER = 40


def column_major(values) -> Matrix:
    rows = np.asarray(values, dtype=np.float64).reshape(4, 4).T
    return Matrix(rows.tolist())


def configure_device(preference: str) -> dict:
    """Uses OptiX (RT cores) where available, else CUDA, else the CPU."""
    scene = bpy.context.scene
    if preference.upper() == "CPU":
        scene.cycles.device = "CPU"
        return {"device": "CPU", "gpus": []}
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI"):
        try:
            prefs.compute_device_type = kind
        except TypeError:
            continue
        prefs.get_devices()
        gpus = [d for d in prefs.devices if d.type == kind]
        if not gpus:
            continue
        for d in prefs.devices:
            d.use = d.type == kind
        scene.cycles.device = "GPU"
        return {"device": kind, "gpus": [d.name for d in gpus]}
    scene.cycles.device = "CPU"
    return {"device": "CPU", "gpus": []}


def configure_denoiser(scene, device: str, mode: str = "auto") -> str:
    """Open Image Denoise, on the GPU when rendering on one. Returns "gpu" or "cpu".

    OptiX's own denoiser fails to start on Modal's runtime, but OIDN runs its own CUDA kernels,
    independent of OptiX. On a GPU the albedo and normal guides are cleaned too (accurate
    prefilter). On a CPU that triples a job that already takes seconds at 1920x1200, so the guides
    are used as rendered (fast prefilter). `mode` "cpu" forces the CPU.
    """
    c = scene.cycles
    c.use_denoising = True
    c.denoiser = "OPENIMAGEDENOISE"
    c.denoising_input_passes = "RGB_ALBEDO_NORMAL"
    gpu = mode != "cpu" and device != "CPU" and hasattr(c, "denoising_use_gpu")
    if hasattr(c, "denoising_use_gpu"):
        c.denoising_use_gpu = gpu
    c.denoising_prefilter = "ACCURATE" if gpu else "FAST"
    return "gpu" if gpu else "cpu"


class Studio:
    """One persistent Blender scene, updated in place from successive descriptions."""

    def __init__(
        self, blob_path: Callable[[str], str], device: str = "auto", denoise: str = "auto"
    ):
        self.blob_path = blob_path
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.scene = bpy.context.scene
        self.scene.render.engine = "CYCLES"
        self.device = configure_device(device)
        self.renders = 0
        # content key -> [data block, last render that used it]
        self.meshes: dict[str, list] = {}
        self.images: dict[tuple[str, bool], list] = {}
        self.materials: dict[str, list] = {}
        self.objects: dict[str, dict] = {}
        self.lights: list = []
        self.environment: str | None = None
        self.instancer = self._instancer_group()
        self._setup_world()
        self._setup_camera()
        self._setup_render()
        self.denoise = configure_denoiser(self.scene, self.device["device"], denoise)

    def set_denoise(self, mode: str):
        self.denoise = configure_denoiser(self.scene, self.device["device"], mode)

    # --- Setup -------------------------------------------------------------------------------

    def _setup_render(self):
        s = self.scene
        r = s.render
        r.use_persistent_data = True
        r.film_transparent = False
        r.resolution_percentage = 100
        r.use_file_extension = False
        r.image_settings.file_format = "OPEN_EXR"
        r.image_settings.color_depth = "16"
        # Written uncompressed to local disk, read back and packed for the wire (protocol.py).
        r.image_settings.exr_codec = "NONE"
        r.image_settings.color_mode = "RGBA"
        s.view_settings.view_transform = "Standard"
        s.view_settings.look = "None"
        c = s.cycles
        c.use_adaptive_sampling = True
        # Matches the browser tracer: ten bounces, glossy filtering, no volumes.
        c.max_bounces = 10
        c.diffuse_bounces = 10
        c.glossy_bounces = 10
        c.transmission_bounces = 10
        c.volume_bounces = 0
        # One-sided surfaces are transparent from behind, which spends transparent bounces.
        c.transparent_max_bounces = 32
        c.sample_clamp_direct = 0
        c.sample_clamp_indirect = 10
        c.blur_glossy = 0.5
        c.use_animated_seed = False
        c.seed = 0

    def _setup_camera(self):
        data = bpy.data.cameras.new("view")
        data.sensor_fit = "VERTICAL"
        self.camera = bpy.data.objects.new("view", data)
        self.scene.collection.objects.link(self.camera)
        self.scene.camera = self.camera

    def _setup_world(self):
        world = bpy.data.worlds.new("sky")
        self.scene.world = world
        world.use_nodes = True
        nt = world.node_tree
        nt.nodes.clear()
        coords = nt.nodes.new("ShaderNodeTexCoord")
        # three.js equirect maps look up +Y as up; Blender's environment lookup takes +Z.
        mapping = nt.nodes.new("ShaderNodeMapping")
        mapping.vector_type = "VECTOR"
        mapping.inputs["Rotation"].default_value = (math.pi / 2, 0, 0)
        self.sky_texture = nt.nodes.new("ShaderNodeTexEnvironment")
        self.sky_texture.interpolation = "Linear"
        self.background = nt.nodes.new("ShaderNodeBackground")
        self.background.inputs["Color"].default_value = (0, 0, 0, 1)
        out = nt.nodes.new("ShaderNodeOutputWorld")
        nt.links.new(coords.outputs["Generated"], mapping.inputs["Vector"])
        nt.links.new(mapping.outputs["Vector"], self.sky_texture.inputs["Vector"])
        nt.links.new(self.background.outputs[0], out.inputs[0])
        self.sky_link = None

    def _instancer_group(self):
        """Geometry nodes that place a source object at per-point 4x4 matrices."""
        ng = bpy.data.node_groups.new("instances", "GeometryNodeTree")
        ng.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
        source = ng.interface.new_socket("Source", in_out="INPUT", socket_type="NodeSocketObject")
        ng.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
        self.instancer_socket = source.identifier
        n = ng.nodes
        group_in = n.new("NodeGroupInput")
        group_out = n.new("NodeGroupOutput")
        info = n.new("GeometryNodeObjectInfo")
        place = n.new("GeometryNodeInstanceOnPoints")
        matrix = n.new("GeometryNodeInputNamedAttribute")
        matrix.data_type = "FLOAT4X4"
        matrix.inputs["Name"].default_value = "matrix"
        transform = n.new("GeometryNodeSetInstanceTransform")
        link = ng.links.new
        link(group_in.outputs[0], place.inputs["Points"])
        link(group_in.outputs[1], info.inputs["Object"])
        link(info.outputs["Geometry"], place.inputs["Instance"])
        link(place.outputs[0], transform.inputs["Instances"])
        link(matrix.outputs[0], transform.inputs["Transform"])
        link(transform.outputs[0], group_out.inputs[0])
        return ng

    # --- Blobs -------------------------------------------------------------------------------

    def _read(self, digest: str) -> bytes:
        path = self.blob_path(digest)
        if not os.path.exists(path):
            raise ProtocolError(f"missing blob {digest}")
        with open(path, "rb") as f:
            return f.read()

    def _touch(self, cache: dict, key):
        entry = cache.get(key)
        if entry:
            entry[1] = self.renders
            return entry[0]
        return None

    # --- Meshes ------------------------------------------------------------------------------

    def mesh(self, digest: str):
        cached = self._touch(self.meshes, digest)
        if cached is not None:
            return cached
        g = parse_geometry(self._read(digest))
        me = bpy.data.meshes.new(digest[:16])
        count = len(g.positions)
        loops = len(g.indices)
        faces = loops // 3
        me.vertices.add(count)
        me.vertices.foreach_set("co", np.ascontiguousarray(g.positions, dtype=np.float32).ravel())
        me.loops.add(loops)
        me.loops.foreach_set("vertex_index", g.indices.astype(np.int32))
        me.polygons.add(faces)
        me.polygons.foreach_set("loop_start", np.arange(0, loops, 3, dtype=np.int32))
        slots = 1
        if g.groups:
            index = np.zeros(faces, dtype=np.int32)
            for start, length, material in g.groups:
                end = min(faces, (start + min(length, loops - start)) // 3)
                index[start // 3 : end] = material
                slots = max(slots, material + 1)
            me.polygons.foreach_set("material_index", index)
        if g.uvs is not None:
            layer = me.uv_layers.new(name="UVMap")
            layer.data.foreach_set("uv", np.ascontiguousarray(g.uvs[g.indices]).ravel())
        me.update(calc_edges=True)
        me.validate(clean_customdata=False)
        if g.normals is not None and len(me.vertices) == count:
            me.polygons.foreach_set("use_smooth", np.ones(len(me.polygons), dtype=bool))
            me.normals_split_custom_set_from_vertices(np.ascontiguousarray(g.normals))
        for _ in range(slots):
            me.materials.append(None)
        self.meshes[digest] = [me, self.renders]
        return me

    # --- Images ------------------------------------------------------------------------------

    def image(self, digest: str, srgb: bool):
        key = (digest, srgb)
        cached = self._touch(self.images, key)
        if cached is not None:
            return cached
        img = bpy.data.images.load(self.blob_path(digest), check_existing=False)
        img.name = digest[:16]
        img.colorspace_settings.name = "sRGB" if srgb else "Non-Color"
        img.alpha_mode = "STRAIGHT"
        self.images[key] = [img, self.renders]
        return img

    # --- Materials ---------------------------------------------------------------------------

    def material(self, params: dict, textures: dict):
        resolved = dict(params)
        maps = {}
        for slot, key in (params.get("maps") or {}).items():
            texture = textures.get(key)
            if texture is None:
                raise ProtocolError(f"unknown texture {key}")
            maps[slot] = texture
        resolved["maps"] = maps
        key = hashlib.sha1(json.dumps(resolved, sort_keys=True).encode()).hexdigest()
        cached = self._touch(self.materials, key)
        if cached is not None:
            return cached
        mat = build_material(key[:16], resolved, self.image)
        self.materials[key] = [mat, self.renders]
        return mat

    # --- Objects -----------------------------------------------------------------------------

    def _assign(self, ob, materials):
        def pick(i):
            return materials[min(i, len(materials) - 1)] if materials else None

        if ob.data.users == 1 and ob.data.name.startswith("copy"):
            # Instanced geometry carries its materials itself: object slots do not reach instances.
            for i in range(len(ob.data.materials)):
                ob.data.materials[i] = pick(i)
            return
        for i, slot in enumerate(ob.material_slots):
            slot.link = "OBJECT"
            slot.material = pick(i)

    def _remove(self, entry):
        for ob in entry["objects"]:
            data = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            if data is not None and data.users == 0 and data.name.startswith(("points", "copy")):
                bpy.data.meshes.remove(data)

    def apply_objects(self, items: list, materials: dict, textures: dict):
        seen = set()
        for item in items:
            oid = str(item["id"])
            seen.add(oid)
            geometry = item["geometry"]
            instances = item.get("instances")
            mats = []
            for key in item.get("materials") or []:
                if key not in materials:
                    raise ProtocolError(f"unknown material {key}")
                mats.append(self.material(materials[key], textures))
            matrix = column_major(item["matrix"])
            entry = self.objects.get(oid)
            if entry and (entry["geometry"] != geometry or entry["instances"] != instances):
                self._remove(entry)
                entry = None
            if entry is None:
                mesh = self.mesh(geometry)
                if instances:
                    copy = mesh.copy()
                    copy.name = f"copy.{oid}"
                    source = bpy.data.objects.new(f"src.{oid}", copy)
                    source.hide_render = True
                    self.scene.collection.objects.link(source)
                    points = bpy.data.meshes.new(f"points.{oid}")
                    xforms = parse_instances(self._read(instances))
                    points.vertices.add(len(xforms))
                    attribute = points.attributes.new("matrix", "FLOAT4X4", "POINT")
                    attribute.data.foreach_set("value", np.ascontiguousarray(xforms).ravel())
                    holder = bpy.data.objects.new(f"inst.{oid}", points)
                    self.scene.collection.objects.link(holder)
                    modifier = holder.modifiers.new("instances", "NODES")
                    modifier.node_group = self.instancer
                    modifier[self.instancer_socket] = source
                    entry = {"objects": [holder, source], "target": source, "placed": holder}
                else:
                    ob = bpy.data.objects.new(f"obj.{oid}", mesh)
                    self.scene.collection.objects.link(ob)
                    entry = {"objects": [ob], "target": ob, "placed": ob}
                entry.update(geometry=geometry, instances=instances, matrix=None, materials=None)
                self.objects[oid] = entry
            else:
                self._touch(self.meshes, geometry)
            if entry["matrix"] != item["matrix"]:
                entry["placed"].matrix_world = matrix
                entry["matrix"] = item["matrix"]
            names = [m.name for m in mats]
            if entry["materials"] != names:
                self._assign(entry["target"], mats)
                entry["materials"] = names
        for oid in [k for k in self.objects if k not in seen]:
            self._remove(self.objects.pop(oid))

    # --- Lights ------------------------------------------------------------------------------

    def apply_lights(self, lights: list):
        kinds = {"area": "AREA", "spot": "SPOT", "point": "POINT", "sun": "SUN"}
        for i, light in enumerate(lights):
            kind = kinds.get(light.get("type"))
            if kind is None:
                raise ProtocolError("unknown light type")
            if i < len(self.lights) and self.lights[i].data.type == kind:
                ob = self.lights[i]
            else:
                data = bpy.data.lights.new(f"light.{i}", kind)
                ob = bpy.data.objects.new(f"light.{i}", data)
                self.scene.collection.objects.link(ob)
                if i < len(self.lights):
                    old = self.lights[i]
                    data_old = old.data
                    bpy.data.objects.remove(old, do_unlink=True)
                    bpy.data.lights.remove(data_old)
                    self.lights[i] = ob
                else:
                    self.lights.append(ob)
            configure_light(ob, light)
        while len(self.lights) > len(lights):
            ob = self.lights.pop()
            data = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            bpy.data.lights.remove(data)

    # --- Sky ---------------------------------------------------------------------------------

    def apply_environment(self, environment: dict | None):
        digest = environment.get("blob") if environment else None
        if digest == self.environment:
            return
        nt = self.scene.world.node_tree
        if self.sky_link is not None:
            nt.links.remove(self.sky_link)
            self.sky_link = None
        old = self.sky_texture.image
        self.sky_texture.image = None
        if old is not None:
            bpy.data.images.remove(old)
        if digest:
            width, height, texels = parse_environment(self._read(digest))
            img = bpy.data.images.new(f"sky.{digest[:12]}", width, height, float_buffer=True)
            img.pixels.foreach_set(texels.ravel())
            self.sky_texture.image = img
            self.sky_link = nt.links.new(
                self.sky_texture.outputs["Color"], self.background.inputs["Color"]
            )
        self.environment = digest

    # --- Rendering ---------------------------------------------------------------------------

    def apply_camera(self, request: dict):
        camera = request["camera"]
        self.camera.matrix_world = column_major(camera["matrix"])
        data = self.camera.data
        if camera.get("panorama"):
            # The whole sphere around the camera, for looking around the interior.
            data.type = "PANO"
            data.panorama_type = "EQUIRECTANGULAR"
        else:
            data.type = "PERSP"
        data.angle_y = math.radians(camera["fov"])
        data.clip_start = max(1e-4, camera["near"])
        data.clip_end = max(data.clip_start * 2, camera["far"])
        r = self.scene.render
        r.resolution_x = request["width"]
        r.resolution_y = request["height"]
        c = self.scene.cycles
        c.samples = request["samples"]
        c.adaptive_threshold = request["threshold"]
        c.time_limit = request["time_limit"]

    def evict(self):
        """Frees data blocks no recent scene used, so the cache follows the current designs."""
        horizon = self.renders - EVICT_AFTER
        used_meshes = {e["geometry"] for e in self.objects.values()}
        for key, (me, last) in list(self.meshes.items()):
            if last < horizon and key not in used_meshes and me.users == 0:
                bpy.data.meshes.remove(me)
                del self.meshes[key]
        for key, (mat, last) in list(self.materials.items()):
            if last < horizon and mat.users == 0:
                bpy.data.materials.remove(mat)
                del self.materials[key]
        for key, (img, last) in list(self.images.items()):
            if last < horizon and img.users == 0:
                bpy.data.images.remove(img)
                del self.images[key]

    def render(self, request: dict, out_path: str) -> dict:
        self.renders += 1
        start = time.perf_counter()
        scene = request["scene"]
        textures = scene.get("textures") or {}
        self.apply_objects(scene.get("objects") or [], scene.get("materials") or {}, textures)
        self.apply_lights(scene.get("lights") or [])
        self.apply_environment(scene.get("environment"))
        self.apply_camera(request)
        prepared = time.perf_counter()
        exr = f"{out_path}.exr"
        self.scene.render.filepath = exr
        try:
            bpy.ops.render.render(write_still=True)
            done = time.perf_counter()
            img = bpy.data.images.load(exr, check_existing=False)
            try:
                width, height = img.size
                pixels = np.empty(width * height * 4, dtype=np.float32)
                img.pixels.foreach_get(pixels)
            finally:
                bpy.data.images.remove(img)
        finally:
            if os.path.exists(exr):
                os.remove(exr)
        pixels = pixels.reshape(height, width, 4)[::-1]
        if request.get("output") == "frame":
            # Finished and encoded by the API process, while the GPU renders the next frame.
            with open(out_path, "wb") as f:
                np.save(f, np.ascontiguousarray(pixels[..., :3], dtype=np.float16))
        else:
            pixels[..., 3] = 1
            with open(out_path, "wb") as f:
                f.write(pack_image(pixels))
        packed = time.perf_counter()
        if self.renders % 10 == 0:
            self.evict()
        return {
            "prepareMs": round((prepared - start) * 1000),
            "renderMs": round((done - prepared) * 1000),
            "packMs": round((packed - done) * 1000),
            "width": width,
            "height": height,
            "device": self.device["device"],
            "denoise": self.denoise,
        }


def configure_light(ob, light: dict):
    data = ob.data
    color = light.get("color") or [1, 1, 1]
    data.color = color[:3]
    intensity = float(light.get("intensity", 0))
    if data.type == "AREA":
        width = float(light["width"])
        height = float(light["height"])
        if light.get("shape") == "ellipse":
            data.shape = "ELLIPSE"
            area = math.pi * width * height / 4
        else:
            data.shape = "RECTANGLE"
            area = width * height
        data.size = width
        data.size_y = height
        # Cycles area light radiance is power / (π · area).
        data.energy = intensity * math.pi * area
        matrix = column_major(light["matrix"])
        loc, rot, _ = matrix.decompose()
        ob.matrix_world = Matrix.LocRotScale(loc, rot, None)
        # The browser tracer's area lights are seen by every ray, as emitting panels.
        ob.visible_camera = True
        ob.visible_glossy = True
        ob.visible_transmission = True
        ob.visible_diffuse = True
    elif data.type in ("SPOT", "POINT"):
        # Point and spot lights of power P have intensity P / 4π W/sr.
        data.energy = intensity * 4 * math.pi
        data.shadow_soft_size = float(light.get("radius", 0))
        if hasattr(data, "use_soft_falloff"):
            data.use_soft_falloff = False
        position = Vector(light["position"])
        rotation = None
        if data.type == "SPOT":
            angle = min(float(light["angle"]), math.pi / 2)
            penumbra = float(light.get("penumbra", 0))
            data.spot_size = 2 * angle
            # three.js fades over cos(angle)..cos(angle·(1 - penumbra)); Cycles over
            # cos(angle)..cos(angle) + (1 - cos(angle))·blend.
            outer = math.cos(angle)
            inner = math.cos(angle * (1 - penumbra))
            data.spot_blend = 0 if outer >= 1 else max(0.0, min(1.0, (inner - outer) / (1 - outer)))
            rotation = Vector(light["direction"]).to_track_quat("-Z", "Y")
        ob.matrix_world = Matrix.LocRotScale(position, rotation, None)
    elif data.type == "SUN":
        # A sun's strength is its irradiance; `direction` points toward the sun.
        data.energy = float(light.get("irradiance", intensity))
        data.angle = float(light.get("angle", 0.0093))
        rotation = (-Vector(light["direction"])).to_track_quat("-Z", "Y")
        ob.matrix_world = Matrix.LocRotScale(None, rotation, None)


# --- Material graphs ---------------------------------------------------------------------------


class Graph:
    def __init__(self, material):
        self.nt = material.node_tree
        self.nt.nodes.clear()
        self.uv_cache: dict = {}
        self.texture_cache: dict = {}

    def node(self, kind, **inputs):
        n = self.nt.nodes.new(kind)
        for name, value in inputs.items():
            self.set(n.inputs[name], value)
        return n

    def set(self, socket, value):
        if hasattr(value, "bl_idname") or hasattr(value, "is_output"):
            self.nt.links.new(value, socket)
        else:
            socket.default_value = value

    def math(self, op, a, b=None, c=None):
        n = self.nt.nodes.new("ShaderNodeMath")
        n.operation = op
        for i, v in enumerate((a, b, c)):
            if v is not None:
                self.set(n.inputs[i], v)
        return n.outputs[0]

    def uv(self, matrix):
        """UVs through a three.js texture matrix (column-major 3x3)."""
        e = [float(v) for v in (matrix or [1, 0, 0, 0, 1, 0, 0, 0, 1])]
        key = tuple(round(v, 6) for v in e)
        if key in self.uv_cache:
            return self.uv_cache[key]
        uvmap = self.nt.nodes.new("ShaderNodeUVMap")
        uvmap.uv_map = "UVMap"
        if key == (1, 0, 0, 0, 1, 0, 0, 0, 1):
            out = uvmap.outputs["UV"]
        else:
            split = self.node("ShaderNodeSeparateXYZ", Vector=uvmap.outputs["UV"])
            u, v = split.outputs["X"], split.outputs["Y"]
            u2 = self.math("MULTIPLY_ADD", u, e[0], self.math("MULTIPLY_ADD", v, e[3], e[6]))
            v2 = self.math("MULTIPLY_ADD", u, e[1], self.math("MULTIPLY_ADD", v, e[4], e[7]))
            out = self.node("ShaderNodeCombineXYZ", X=u2, Y=v2).outputs[0]
        self.uv_cache[key] = out
        return out

    def texture(self, texture: dict, srgb: bool, image_for):
        key = (texture["blob"], srgb, tuple(texture.get("matrix") or ()))
        if key in self.texture_cache:
            return self.texture_cache[key]
        n = self.nt.nodes.new("ShaderNodeTexImage")
        n.image = image_for(texture["blob"], srgb)
        n.interpolation = "Linear"
        wrap = texture.get("wrap") or "repeat"
        n.extension = {"repeat": "REPEAT", "mirror": "MIRROR"}.get(wrap, "EXTEND")
        self.set(n.inputs["Vector"], self.uv(texture.get("matrix")))
        self.texture_cache[key] = n
        return n

    def channel(self, color_output, index):
        split = self.node("ShaderNodeSeparateColor", Color=color_output)
        return split.outputs[index]


def _rgb(value, default=(1.0, 1.0, 1.0)):
    v = value if isinstance(value, (list, tuple)) and len(value) >= 3 else default
    return (float(v[0]), float(v[1]), float(v[2]), 1.0)


def build_material(name: str, p: dict, image_for):
    """A Principled material equivalent to a three.js MeshStandard/MeshPhysicalMaterial."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    g = Graph(mat)
    maps = p.get("maps") or {}
    out = g.node("ShaderNodeOutputMaterial")
    bsdf = g.node("ShaderNodeBsdfPrincipled")

    color = _rgb(p.get("color"))
    base = maps.get("map")
    base_node = g.texture(base, base.get("srgb", True), image_for) if base else None
    if base_node:
        mul = g.node("ShaderNodeVectorMath", Vector=base_node.outputs["Color"])
        mul.operation = "MULTIPLY"
        mul.inputs[1].default_value = color[:3]
        g.set(bsdf.inputs["Base Color"], mul.outputs[0])
    else:
        bsdf.inputs["Base Color"].default_value = color

    def scalar(input_name, value, slot, channel):
        tex = maps.get(slot)
        if tex:
            node = g.texture(tex, False, image_for)
            g.set(
                bsdf.inputs[input_name],
                g.math("MULTIPLY", g.channel(node.outputs["Color"], channel), value),
            )
        else:
            bsdf.inputs[input_name].default_value = value

    # three.js reads roughness from green and metalness from blue.
    scalar("Roughness", float(p.get("roughness", 1)), "roughnessMap", 1)
    scalar("Metallic", float(p.get("metalness", 0)), "metalnessMap", 2)
    bsdf.inputs["IOR"].default_value = float(p.get("ior", 1.5))
    bsdf.inputs["Specular IOR Level"].default_value = 0.5 * float(p.get("specularIntensity", 1))
    bsdf.inputs["Specular Tint"].default_value = _rgb(p.get("specularColor"))
    bsdf.inputs["Coat Weight"].default_value = float(p.get("clearcoat", 0))
    bsdf.inputs["Coat Roughness"].default_value = float(p.get("clearcoatRoughness", 0))
    bsdf.inputs["Sheen Weight"].default_value = float(p.get("sheen", 0))
    bsdf.inputs["Sheen Roughness"].default_value = float(p.get("sheenRoughness", 1))
    bsdf.inputs["Sheen Tint"].default_value = _rgb(p.get("sheenColor"), (0.0, 0.0, 0.0))

    emissive = _rgb(p.get("emissive"), (0.0, 0.0, 0.0))
    strength = float(p.get("emissiveIntensity", 1))
    if strength > 0 and (any(emissive[:3]) or maps.get("emissiveMap")):
        em = maps.get("emissiveMap")
        if em:
            node = g.texture(em, em.get("srgb", True), image_for)
            mul = g.node("ShaderNodeVectorMath", Vector=node.outputs["Color"])
            mul.operation = "MULTIPLY"
            mul.inputs[1].default_value = emissive[:3]
            g.set(bsdf.inputs["Emission Color"], mul.outputs[0])
        else:
            bsdf.inputs["Emission Color"].default_value = emissive
        bsdf.inputs["Emission Strength"].default_value = strength

    normal = maps.get("normalMap")
    if normal:
        node = g.texture(normal, False, image_for)
        scale = p.get("normalScale") or [1, 1]
        color_out = node.outputs["Color"]
        if (scale[0] >= 0) != (scale[1] >= 0):
            split = g.node("ShaderNodeSeparateColor", Color=color_out)
            flipped = g.math("SUBTRACT", 1.0, split.outputs[1])
            color_out = g.node(
                "ShaderNodeCombineColor", Red=split.outputs[0], Green=flipped, Blue=split.outputs[2]
            ).outputs[0]
        nmap = g.node("ShaderNodeNormalMap", Color=color_out, Strength=abs(float(scale[0])))
        nmap.uv_map = "UVMap"
        g.set(bsdf.inputs["Normal"], nmap.outputs[0])

    # Alpha counts only where three.js would use it: blended or alpha-tested materials.
    alpha_test = float(p.get("alphaTest", 0))
    if p.get("transparent") or alpha_test > 0:
        alpha = float(p.get("opacity", 1))
        socket = None
        if base_node is not None:
            socket = g.math("MULTIPLY", base_node.outputs["Alpha"], alpha)
        amap = maps.get("alphaMap")
        if amap:
            node = g.texture(amap, False, image_for)
            green = g.channel(node.outputs["Color"], 1)
            socket = g.math("MULTIPLY", socket if socket is not None else alpha, green)
        if alpha_test > 0:
            socket = g.math(
                "GREATER_THAN", socket if socket is not None else alpha, alpha_test - 1e-4
            )
        g.set(bsdf.inputs["Alpha"], socket if socket is not None else alpha)

    shader = bsdf.outputs[0]
    transmission = float(p.get("transmission", 0))
    if transmission > 0:
        # Thin-walled glass, as the browser tracer renders panes: light passes straight through,
        # tinted by the base color, and the surface reflects by Fresnel (Schlick's). A pane
        # reflects alike from either side: Cycles' Fresnel node treats a back face as light
        # leaving glass, which totally reflects beyond 41° and turned windows seen from inside
        # into dark mirrors.
        ior = float(p.get("ior", 1.5))
        f0 = ((ior - 1) / (ior + 1)) ** 2
        geometry = g.node("ShaderNodeNewGeometry")
        facing = g.node("ShaderNodeVectorMath")
        facing.operation = "DOT_PRODUCT"
        g.set(facing.inputs[0], geometry.outputs["Incoming"])
        g.set(facing.inputs[1], geometry.outputs["Normal"])
        cosine = g.math("ABSOLUTE", facing.outputs["Value"])
        grazing = g.math("POWER", g.math("SUBTRACT", 1.0, cosine), 5.0)
        fresnel = g.math("MULTIPLY_ADD", grazing, 1 - f0, f0)
        clear = g.node("ShaderNodeBsdfTransparent", Color=color)
        gloss = g.node("ShaderNodeBsdfGlossy", Roughness=float(p.get("roughness", 0)))
        gloss.distribution = "GGX"
        glass = g.node("ShaderNodeMixShader", Fac=fresnel)
        g.set(glass.inputs[1], clear.outputs[0])
        g.set(glass.inputs[2], gloss.outputs[0])
        mixed = g.node("ShaderNodeMixShader", Fac=min(1.0, transmission))
        g.set(mixed.inputs[1], shader)
        g.set(mixed.inputs[2], glass.outputs[0])
        shader = mixed.outputs[0]

    side = int(p.get("side", FRONT_SIDE))
    if side in (FRONT_SIDE, BACK_SIDE):
        # The browser tracer ignores faces from the wrong side for every ray except shadows.
        geometry = g.node("ShaderNodeNewGeometry")
        path = g.node("ShaderNodeLightPath")
        facing = geometry.outputs["Backfacing"]
        if side == BACK_SIDE:
            facing = g.math("SUBTRACT", 1.0, facing)
        cull = g.math("MULTIPLY", facing, g.math("SUBTRACT", 1.0, path.outputs["Is Shadow Ray"]))
        hole = g.node("ShaderNodeBsdfTransparent", Color=(1, 1, 1, 1))
        culled = g.node("ShaderNodeMixShader", Fac=cull)
        g.set(culled.inputs[1], shader)
        g.set(culled.inputs[2], hole.outputs[0])
        shader = culled.outputs[0]

    g.set(out.inputs["Surface"], shader)
    return mat


def warm_up(studio: Studio, out_path: str):
    """Renders a tiny scene so device kernels are loaded before the first real request."""
    studio.scene.render.resolution_x = 32
    studio.scene.render.resolution_y = 32
    studio.scene.cycles.samples = 1
    studio.scene.render.filepath = out_path
    bpy.ops.render.render(write_still=True)
