"""Convert prop FBX/OBJ files that share one color atlas into placeable GLBs.

Run inside Blender: blender -b --factory-startup --python blender_convert.py -- jobs.json
jobs.json: {"atlas": "/path/atlas.png", "atlas_size": 512, "items": [{"source": ".../a.fbx", "glb": ".../a.glb", "thumb": ".../a.png"}]}
Each GLB stands on its origin (base at y = 0, centered), is Draco compressed and
embeds the atlas downsized. Results (height in meters, triangle count) are
written next to jobs.json as results.json.
"""
import bpy, json, math, os, sys
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
jobs_path = args[0]
jobs = json.load(open(jobs_path))
results = []

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def atlas_material(image):
    material = bpy.data.materials.new("Atlas")
    if hasattr(material, "use_nodes") and not material.use_nodes:
        material.use_nodes = True
    nodes = material.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    texture.interpolation = "Closest"
    material.node_tree.links.new(texture.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.8
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.0
    return material

def bounds(objects):
    low = Vector((math.inf,) * 3)
    high = Vector((-math.inf,) * 3)
    for obj in objects:
        for corner in obj.bound_box:
            world = obj.matrix_world @ Vector(corner)
            low = Vector(map(min, low, world))
            high = Vector(map(max, high, world))
    return low, high

for item in jobs["items"]:
    try:
        reset()
        source = item["source"]
        if source.lower().endswith(".fbx"):
            bpy.ops.import_scene.fbx(filepath=source)
        else:
            bpy.ops.wm.obj_import(filepath=source)
        meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        if not meshes:
            raise RuntimeError("no meshes")
        for obj in list(bpy.context.scene.objects):
            if obj.type not in ("MESH", "EMPTY"):
                bpy.data.objects.remove(obj, do_unlink=True)
        image = bpy.data.images.load(jobs["atlas"], check_existing=True)
        if max(image.size) > jobs.get("atlas_size", 512):
            size = jobs.get("atlas_size", 512)
            image.scale(size, size)
        material = atlas_material(image)
        for obj in meshes:
            obj.data.materials.clear()
            obj.data.materials.append(material)
        bpy.context.view_layer.update()
        low, high = bounds(meshes)
        size = high - low
        # Sources come in centimeters or with the unit scale applied twice; props are 5 cm to 40 m.
        largest = max(size)
        factor = 0.01 if largest > 40 else 100.0 if largest < 0.05 else 1.0
        root = bpy.data.objects.new("Root", None)
        bpy.context.scene.collection.objects.link(root)
        for obj in bpy.context.scene.objects:
            if obj is not root and obj.parent is None:
                obj.parent = root
        center = (low + high) / 2
        root.location = Vector((-center.x * factor, -center.y * factor, -low.z * factor))
        root.scale = (factor, factor, factor)
        bpy.context.view_layer.update()
        low, high = bounds(meshes)
        size = high - low
        triangles = sum(sum(len(poly.vertices) - 2 for poly in obj.data.polygons) for obj in meshes)
        os.makedirs(os.path.dirname(item["glb"]), exist_ok=True)
        bpy.ops.export_scene.gltf(filepath=item["glb"], export_format="GLB", export_draco_mesh_compression_enable=True,
            export_draco_mesh_compression_level=6, export_image_format="JPEG", export_apply=True, export_yup=True,
            export_cameras=False, export_lights=False, export_animations=False)
        # Thumbnail: workbench with texture colors, three-quarter view, transparent background.
        scene = bpy.context.scene
        scene.render.engine = "BLENDER_WORKBENCH"
        scene.display.shading.color_type = "TEXTURE"
        scene.display.shading.light = "STUDIO"
        scene.render.film_transparent = True
        scene.render.resolution_x = scene.render.resolution_y = 192
        scene.render.image_settings.file_format = "PNG"
        camera_data = bpy.data.cameras.new("Camera")
        camera_data.lens = 50
        camera = bpy.data.objects.new("Camera", camera_data)
        scene.collection.objects.link(camera)
        scene.camera = camera
        middle = (low + high) / 2
        radius = max(size.length / 2, 0.05)
        distance = radius / math.sin(math.radians(18)) * 1.05
        direction = Vector((0.75, -1.0, 0.6)).normalized()
        camera.location = middle + direction * distance
        camera.rotation_euler = (middle - camera.location).to_track_quat("-Z", "Y").to_euler()
        camera_data.clip_end = distance * 10
        scene.render.filepath = item["thumb"]
        bpy.ops.render.render(write_still=True)
        results.append({"source": source, "glb": item["glb"], "thumb": item["thumb"], "height": round(size.z, 3),
            "width": round(max(size.x, size.y), 3), "triangles": triangles, "ok": True})
    except Exception as error:
        results.append({"source": item["source"], "ok": False, "error": str(error)})

json.dump(results, open(os.path.join(os.path.dirname(jobs_path), "results.json"), "w"), indent=1)
