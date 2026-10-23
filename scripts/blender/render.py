"""Path-traces a scene exported by export.mjs with Cycles.

blender -b --factory-startup -P scripts/blender/render.py -- scene.json out.png [--samples N]
    [--width W] [--height H] [--gpu]

Geometry arrives in feet with three.js axes (y up, front +z); Blender works in metres, z up.
Materials are rebuilt from the same MaterialSpec the web material library reads, over the same
scanned texture sets in public/textures, at the same physical scale (UVs are in feet).
"""

import base64
import json
import math
import os
import sys
import time

import bpy
import numpy as np

FT = 0.3048
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TEXTURES = os.path.join(ROOT, "public", "textures")

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
scene_path, out_path = argv[0], argv[1]


def option(name, default):
    return type(default)(argv[argv.index(name) + 1]) if name in argv else default


SAMPLES = option("--samples", 128)
WIDTH = option("--width", 1600)
HEIGHT = option("--height", 900)

data = json.load(open(scene_path))
config = data["config"]
sets = data["textureSets"]


def axes(v):
    """three.js (x, y, z) feet -> Blender (x, -z, y) metres."""
    a = v.reshape(-1, 3)
    return np.stack([a[:, 0], -a[:, 2], a[:, 1]], axis=1)


def decode(b64, dtype):
    return np.frombuffer(base64.b64decode(b64), dtype=dtype)


def srgb(hex_color):
    """CSS hex -> linear RGB, as three.js Color does."""
    h = str(hex_color).lstrip("#")
    c = [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


# --- Scene reset -------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.unit_settings.system = "METRIC"

# --- Materials -----------------------------------------------------------------------------
images = {}


def image(set_name, kind):
    key = (set_name, kind)
    if key not in images:
        path = os.path.join(TEXTURES, set_name, f"{kind}.webp")
        if not os.path.exists(path):
            images[key] = None
        else:
            img = bpy.data.images.load(path, check_existing=True)
            img.colorspace_settings.name = "sRGB" if kind == "albedo" else "Non-Color"
            images[key] = img
    return images[key]


materials = {}


def build_material(spec):
    key = json.dumps(spec, sort_keys=True)
    if key in materials:
        return materials[key]
    m = bpy.data.materials.new(f"spec{len(materials)}")
    m.use_nodes = True
    nt = m.node_tree
    nodes, links = nt.nodes, nt.links
    bsdf = nodes["Principled BSDF"]
    out = nodes["Material Output"]
    color = srgb(spec.get("color", "#ffffff")) + [1]
    textured = spec.get("set")
    roughness = spec.get("roughness", 1 if textured else 0.6)
    metalness = spec.get("metalness", 0)
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metalness

    if textured:
        info = sets[textured]
        uv = nodes.new("ShaderNodeTexCoord")
        mapping = nodes.new("ShaderNodeMapping")
        s = 1 / info["size"]
        mapping.inputs["Scale"].default_value = (s, s, 1)
        links.new(uv.outputs["UV"], mapping.inputs["Vector"])

        def tex(kind):
            img = image(textured, kind)
            if img is None:
                return None
            t = nodes.new("ShaderNodeTexImage")
            t.image = img
            t.interpolation = "Smart"
            links.new(mapping.outputs["Vector"], t.inputs["Vector"])
            return t

        albedo = None if info.get("detailOnly") else tex("albedo")
        if albedo:
            mul = nodes.new("ShaderNodeMix")
            mul.data_type = "RGBA"
            mul.blend_type = "MULTIPLY"
            mul.inputs["Factor"].default_value = 1
            links.new(albedo.outputs["Color"], mul.inputs["A"])
            mul.inputs["B"].default_value = color
            links.new(mul.outputs["Result"], bsdf.inputs["Base Color"])
        arm = tex("arm")
        if arm:
            sep = nodes.new("ShaderNodeSeparateColor")
            links.new(arm.outputs["Color"], sep.inputs["Color"])
            # three multiplies the roughness/metalness factors by the map's G and B channels.
            r = nodes.new("ShaderNodeMath")
            r.operation = "MULTIPLY"
            r.inputs[1].default_value = roughness
            links.new(sep.outputs["Green"], r.inputs[0])
            links.new(r.outputs["Value"], bsdf.inputs["Roughness"])
            if info.get("metallic"):
                mm = nodes.new("ShaderNodeMath")
                mm.operation = "MULTIPLY"
                mm.inputs[1].default_value = metalness
                links.new(sep.outputs["Blue"], mm.inputs[0])
                links.new(mm.outputs["Value"], bsdf.inputs["Metallic"])
            # Ambient occlusion (R) is skipped: the path tracer computes the real thing.
        normal = tex("normal")
        if normal:
            nm = nodes.new("ShaderNodeNormalMap")
            nm.inputs["Strength"].default_value = spec.get("normalScale", 1)
            links.new(normal.outputs["Color"], nm.inputs["Color"])
            links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])

    if "clearcoat" in spec:
        bsdf.inputs["Coat Weight"].default_value = spec["clearcoat"]
        bsdf.inputs["Coat Roughness"].default_value = spec.get("clearcoatRoughness", 0.1)
    if "sheen" in spec:
        bsdf.inputs["Sheen Weight"].default_value = spec["sheen"]
        bsdf.inputs["Sheen Roughness"].default_value = spec.get("sheenRoughness", 0.6)
        if "sheenColor" in spec:
            bsdf.inputs["Sheen Tint"].default_value = srgb(spec["sheenColor"]) + [1]
    if "specularIntensity" in spec:
        bsdf.inputs["Specular IOR Level"].default_value = 0.5 * spec["specularIntensity"]
    if "ior" in spec:
        bsdf.inputs["IOR"].default_value = spec["ior"]

    glass = spec.get("thinGlass") or spec.get("transmission", 0) > 0
    if glass:
        bsdf.inputs["Transmission Weight"].default_value = spec.get("transmission", 1)
        bsdf.inputs["Roughness"].default_value = spec.get("roughness", 0)
        if spec.get("thinGlass"):
            # Clear float glazing: a thin pane, colourless.
            bsdf.inputs["Base Color"].default_value = (1, 1, 1, 1)
            bsdf.inputs["Thin Wall"].default_value = True
        elif "attenuationColor" in spec:
            bsdf.inputs["Base Color"].default_value = srgb(spec["attenuationColor"]) + [1]
        # Shadow rays pass through glazing (as caustic-free renderers do), so daylight reaches
        # the room without needing caustics to converge.
        lp = nodes.new("ShaderNodeLightPath")
        clear = nodes.new("ShaderNodeBsdfTransparent")
        mix = nodes.new("ShaderNodeMixShader")
        links.new(lp.outputs["Is Shadow Ray"], mix.inputs["Fac"])
        links.new(bsdf.outputs["BSDF"], mix.inputs[1])
        links.new(clear.outputs["BSDF"], mix.inputs[2])
        links.new(mix.outputs["Shader"], out.inputs["Surface"])

    if spec.get("emissive"):
        bsdf.inputs["Emission Color"].default_value = srgb(spec["emissive"]) + [1]
        # three's emissive is display radiance; Cycles strength is scaled to read alike under AgX.
        bsdf.inputs["Emission Strength"].default_value = spec.get("emissiveIntensity", 1) * 3
    if spec.get("transparent") and spec.get("opacity", 1) < 1 and not glass:
        bsdf.inputs["Alpha"].default_value = spec["opacity"]
    materials[key] = m
    return m


# --- Meshes --------------------------------------------------------------------------------
collection = scene.collection
for i, mesh_data in enumerate(data["meshes"]):
    p = axes(decode(mesh_data["position"], np.float32)) * FT
    n = axes(decode(mesh_data["normal"], np.float32))
    uv = decode(mesh_data["uv"], np.float32).reshape(-1, 2)
    idx = decode(mesh_data["index"], np.uint32).reshape(-1, 3)
    me = bpy.data.meshes.new(f"m{i}")
    me.vertices.add(len(p))
    me.vertices.foreach_set("co", p.ravel())
    me.loops.add(idx.size)
    me.loops.foreach_set("vertex_index", idx.ravel().astype(np.int32))
    me.polygons.add(len(idx))
    me.polygons.foreach_set("loop_start", np.arange(0, idx.size, 3, dtype=np.int32))
    me.polygons.foreach_set("loop_total", np.full(len(idx), 3, dtype=np.int32))
    layer = me.uv_layers.new(name="UV")
    layer.data.foreach_set("uv", uv[idx.ravel()].ravel())
    me.update(calc_edges=True)
    me.validate(clean_customdata=False)
    me.normals_split_custom_set_from_vertices(n.tolist())
    me.polygons.foreach_set("use_smooth", np.ones(len(idx), dtype=bool))
    me.materials.append(build_material(mesh_data["spec"]))
    ob = bpy.data.objects.new(f"o{i}", me)
    collection.objects.link(ob)

# --- Site: lawn with a paved apron (a stand-in for the app's landscape) ----------------------
L = config["length"]
for name, size, spec, z in (
    ("lawn", 400, {"set": "leafy_grass", "color": "#c9d4b0", "roughness": 1}, 0.0),
    (
        "apron",
        None,
        {"set": "concrete_pavement", "color": "#d6d1c7", "roughness": 1},
        0.004,
    ),
):
    if size:
        w, d = size, size
        cx, cy = 0, 0
    else:
        w, d = (L + 14) * FT, 30 * FT
        cx, cy = 0, -3 * FT
    bpy.ops.mesh.primitive_plane_add(size=1, location=(cx, cy, z))
    ob = bpy.context.object
    ob.scale = (w, d, 1)
    bpy.ops.object.transform_apply(scale=True)
    # UVs in feet, like the app's geometry.
    for loop in ob.data.loops:
        co = ob.data.vertices[loop.vertex_index].co
        ob.data.uv_layers.active.data[loop.index].uv = (co.x / FT, co.y / FT)
    ob.data.materials.append(build_material(spec))

# --- Sky and sun ---------------------------------------------------------------------------
sun = data["sun"]["direction"]  # three.js, toward the sun
d = (sun[0], -sun[2], sun[1])
elevation = math.asin(max(-1, min(1, d[2])))
world = bpy.data.worlds.new("sky")
scene.world = world
world.use_nodes = True
sky = world.node_tree.nodes.new("ShaderNodeTexSky")
sky.sky_type = "MULTIPLE_SCATTERING"
sky.sun_disc = True
sky.sun_elevation = elevation
# Rotation about the zenith. Not yet checked against the web scene's shadow direction.
sky.sun_rotation = math.atan2(d[0], d[1])
sky.air_density = 1.0
sky.aerosol_density = 1.2
bg = world.node_tree.nodes["Background"]
world.node_tree.links.new(sky.outputs["Color"], bg.inputs["Color"])
bg.inputs["Strength"].default_value = 1.0

# --- Camera --------------------------------------------------------------------------------
cam_data = bpy.data.cameras.new("cam")
cam = bpy.data.objects.new("cam", cam_data)
collection.objects.link(cam)
scene.camera = cam
pos = np.array(axes(np.array(data["camera"]["position"], dtype=np.float64))[0]) * FT
look = np.array(axes(np.array(data["camera"]["look"], dtype=np.float64))[0]) * FT
cam.location = pos
direction = look - pos
cam.rotation_mode = "QUATERNION"
from mathutils import Vector

cam.rotation_quaternion = Vector(direction).to_track_quat("-Z", "Y")
cam_data.sensor_fit = "VERTICAL"
cam_data.angle_y = math.radians(data["camera"]["fov"])
cam_data.clip_end = 1000

# --- Render --------------------------------------------------------------------------------
cy = scene.cycles
if "--gpu" in argv:
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for backend in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):
        try:
            prefs.compute_device_type = backend
            prefs.get_devices()
            if any(dev.type == backend for dev in prefs.devices):
                for dev in prefs.devices:
                    dev.use = dev.type == backend
                cy.device = "GPU"
                break
        except TypeError:
            continue
cy.samples = SAMPLES
cy.use_adaptive_sampling = True
cy.adaptive_threshold = 0.02
cy.use_denoising = True
cy.denoiser = "OPENIMAGEDENOISE"
cy.max_bounces = 8
cy.caustics_reflective = False
cy.caustics_refractive = False
cy.blur_glossy = 1.0
scene.render.resolution_x = WIDTH
scene.render.resolution_y = HEIGHT
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
try:
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Base Contrast"
except TypeError:
    pass
scene.view_settings.exposure = option("--exposure", 0.0)
scene.render.filepath = os.path.abspath(out_path)
start = time.time()
bpy.ops.render.render(write_still=True)
print(f"RENDERED {out_path} in {time.time() - start:.1f}s at {WIDTH}x{HEIGHT}, {SAMPLES} spp")
