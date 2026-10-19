"""Corrected native reference cyclorama and interior fixtures; no external calls."""

import math


def build_lighting(studio, design, environment):
    import bpy
    from mathutils import Vector

    scene = studio.scene
    night = "-night-" in design["presentation"]["lookRef"]
    c = design["config"]
    length = c["product"]["lengthFt"]
    is_studio = c["product"]["family"] == "studio"
    ceiling = 9.86 if is_studio else 8.78
    if c["appearance"]["interior"] == "slatted":
        ceiling -= 0.42 if is_studio else 0.38
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 8
    if environment == "studio":
        studio.background.inputs["Color"].default_value = (0.65, 0.68, 0.75, 1)
        studio.background.inputs["Strength"].default_value = 0.04 if night else 0.35
        bpy.ops.mesh.primitive_plane_add(
            size=10000, location=(0, -0.03, 0), rotation=(-math.pi / 2, 0, 0)
        )
        floor = bpy.context.object
        material = bpy.data.materials.new("studio-ground")
        material.use_nodes = True
        bsdf = material.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = (0.23, 0.24, 0.26, 1)
        bsdf.inputs["Roughness"].default_value = 0.6
        floor.data.materials.append(material)
        profile = [
            (
                -120 - 40 * math.sin(t * math.pi / 128),
                40 * (1 - math.cos(t * math.pi / 128)),
            )
            for t in range(65)
        ]
        profile.append((-160, 1000))
        mesh = bpy.data.meshes.new("studio-cyclorama")
        mesh.from_pydata(
            [(x, y - 0.03, z) for z, y in profile for x in (-1000, 1000)],
            [],
            [(2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2) for i in range(len(profile) - 1)],
        )
        mesh.update()
        for polygon in mesh.polygons:
            polygon.use_smooth = True
        backdrop = bpy.data.objects.new("studio-cyclorama", mesh)
        scene.collection.objects.link(backdrop)
        backdrop.data.materials.append(material)

    def area(name, location, watts, size, color, target=(0, 4, 0), height=None):
        light = bpy.data.lights.new(name, "AREA")
        light.energy, light.shape, light.size, light.color = (
            watts,
            "RECTANGLE" if height else "DISK",
            size,
            color,
        )
        if height:
            light.size_y = height
        obj = bpy.data.objects.new(name, light)
        scene.collection.objects.link(obj)
        obj.location = location
        obj.rotation_euler = (
            (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()
        )

    scale = length / 20
    if environment == "studio":
        for name, location, watts, size, color in [
            ("key", (-12, 23, 18), 5000, 18, (1, 0.94, 0.86)),
            ("fill", (22, 12, 5), 1800, 14, (0.83, 0.91, 1)),
            ("rim", (-12, 12, -16), 3000, 12, (1, 0.98, 0.95)),
        ]:
            area(
                name,
                (location[0] * scale, location[1], location[2]),
                watts * scale * (0.15 if night else 1),
                size * scale,
                color,
            )
    emission = bpy.data.materials.new("fixture-diffuser")
    emission.use_nodes = True
    bsdf = emission.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (1, 0.88, 0.74, 1)
    bsdf.inputs["Emission Color"].default_value = (1, 0.88, 0.74, 1)
    linear = c["appearance"]["interior"] in ("gallery", "birch")
    bsdf.inputs["Emission Strength"].default_value = 2.2 if linear else 4.5
    if linear:
        channel = length - 3.4
        for z in (-1.45, 1.35):
            bpy.ops.mesh.primitive_cube_add(size=1, location=(0, ceiling - 0.016, z))
            lens = bpy.context.object
            lens.dimensions = (channel, 0.02, 0.14)
            lens.data.materials.append(emission)
            area(
                "linear-wash",
                (0, ceiling - 0.03, z),
                math.pi * channel * 0.14 * 24,
                channel,
                (1, 0.76, 0.54),
                (0, 0.96, z),
                0.14,
            )
    else:
        columns = (
            [-6, -2, 2, 6] if length == 20 else [-16, -12, -8, -4, 0, 4, 8, 12, 16]
        )
        for x in columns:
            for z in (-1.3, 1.5):
                bpy.ops.mesh.primitive_cylinder_add(
                    vertices=24,
                    radius=0.11,
                    depth=0.01,
                    location=(x + 0.12, ceiling - 0.005, z),
                    rotation=(math.pi / 2, 0, 0),
                )
                bpy.context.object.data.materials.append(emission)
                area(
                    "downlight",
                    (x + 0.12, ceiling - 0.03, z),
                    35,
                    0.22,
                    (1, 0.76, 0.54),
                    (x + 0.12, 0.96, z - 0.4),
                )
