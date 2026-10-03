"""Convert props into placeable GLBs: FBX/OBJ files that share one color atlas, or
glTF/GLB files that bring their own materials (then "atlas" is null).

Run inside Blender: blender -b --factory-startup --python blender_convert.py -- jobs.json
jobs.json: {"atlas": "/path/atlas.png" or null, "atlas_size": 512, "scale": null, "image_format": "JPEG",
  "items": [{"source": ".../a.fbx", "glb": ".../a.glb", "thumb": ".../a.png", "spec": {"height": 1.2, "rotate": [90, 0, 0]}}]}
Each GLB stands on its origin (base at y = 0, centered), is Draco compressed and
embeds its textures at most atlas_size pixels. A spec height (meters) sizes the
prop; otherwise the job's scale, or a unit guess. Results (height in meters,
triangle count) are written next to jobs.json as results.json.
"""
import bpy, json, math, os, re, sys
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

def simplify_materials(size):
    """Keep base colors only: the viewer lights placed props softly, so normal and
    metal/roughness maps add bytes without changing the look."""
    for material in bpy.data.materials:
        if not material.node_tree:
            continue
        nodes = material.node_tree.nodes
        bsdf = next((node for node in nodes if node.type == "BSDF_PRINCIPLED"), None)
        if not bsdf:
            continue
        for name in ("Normal", "Metallic", "Roughness", "Emission Color", "Emission"):
            socket = bsdf.inputs.get(name)
            if socket:
                for link in list(socket.links):
                    material.node_tree.links.remove(link)
        bsdf.inputs["Roughness"].default_value = 0.8
        bsdf.inputs["Metallic"].default_value = 0.0
        for node in list(nodes):
            if node.type in ("NORMAL_MAP", "SEPARATE_COLOR", "SEPRGB") and not any(output.links for output in node.outputs):
                nodes.remove(node)
        for node in list(nodes):
            if node.type == "TEX_IMAGE" and not any(output.links for output in node.outputs):
                nodes.remove(node)
    for image in bpy.data.images:
        if image.users and max(image.size) > size:
            ratio = size / max(image.size)
            image.scale(max(1, round(image.size[0] * ratio)), max(1, round(image.size[1] * ratio)))

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
        spec = item.get("spec") or {}
        if source.lower().endswith(".fbx"):
            bpy.ops.import_scene.fbx(filepath=source)
        elif source.lower().endswith((".glb", ".gltf")):
            bpy.ops.import_scene.gltf(filepath=source)
        else:
            bpy.ops.wm.obj_import(filepath=source)
        # A file holding many characters or props: keep the one this item names.
        if spec.get("keep"):
            keep = re.compile(spec["keep"])
            for obj in list(bpy.context.scene.objects):
                if obj.type == "MESH" and not keep.search(obj.name):
                    bpy.data.objects.remove(obj, do_unlink=True)
        # Helper meshes (collision shapes, stray spheres) would skew the size and the thumbnail.
        drop = re.compile(spec.get("drop") or r"(?i)collision|^icosphere(\.\d+)?$")
        for obj in list(bpy.context.scene.objects):
            if obj.type == "MESH" and drop.search(obj.name):
                bpy.data.objects.remove(obj, do_unlink=True)
        meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        if not meshes:
            raise RuntimeError("no meshes")
        # Rigged props: bake the posed shape into the mesh and drop the armature.
        depsgraph = bpy.context.evaluated_depsgraph_get()
        for obj in meshes:
            if any(modifier.type == "ARMATURE" for modifier in obj.modifiers):
                evaluated = obj.evaluated_get(depsgraph)
                world = evaluated.matrix_world.copy()
                obj.data = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
                obj.modifiers.clear()
                obj.parent = None
                obj.matrix_world = world
            elif obj.parent and obj.parent.type not in ("MESH", "EMPTY"):
                world = obj.matrix_world.copy()
                obj.parent = None
                obj.matrix_world = world
        for obj in list(bpy.context.scene.objects):
            if obj.type not in ("MESH", "EMPTY"):
                bpy.data.objects.remove(obj, do_unlink=True)
        atlas = item.get("atlas") or jobs.get("atlas")
        if atlas:
            image = bpy.data.images.load(atlas, check_existing=True)
            if max(image.size) > jobs.get("atlas_size", 512):
                size = jobs.get("atlas_size", 512)
                image.scale(size, size)
            material = atlas_material(image)
            for obj in meshes:
                obj.data.materials.clear()
                obj.data.materials.append(material)
        else:
            simplify_materials(jobs.get("atlas_size", 512))
        if spec.get("rotate"):
            # Stand a flat-lying prop (a coin, a key) upright, in degrees about x, y, z.
            pivot = bpy.data.objects.new("Pivot", None)
            bpy.context.scene.collection.objects.link(pivot)
            for obj in bpy.context.scene.objects:
                if obj is not pivot and obj.parent is None:
                    obj.parent = pivot
            pivot.rotation_euler = [math.radians(value) for value in spec["rotate"]]
        bpy.context.view_layer.update()
        low, high = bounds(meshes)
        size = high - low
        largest = max(size)
        if spec.get("height"):
            factor = spec["height"] / max(size.z, 1e-6)
        elif jobs.get("scale"):
            factor = jobs["scale"]
        else:
            # Sources come in centimeters or with the unit scale applied twice; props are 5 cm to 40 m.
            factor = 0.01 if largest > 40 else 100.0 if largest < 0.05 else 1.0
            # A few files in a pack carry a different unit scale than the rest; no prop is taller
            # than max_height (meters) or smaller than a centimeter.
            while size.z * factor > jobs.get("max_height", 30):
                factor *= 0.01
            while 0 < size.z * factor < 0.01:
                factor *= 100.0
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
            export_draco_mesh_compression_level=6, export_image_format=jobs.get("image_format", "JPEG"), export_apply=True, export_yup=True,
            export_cameras=False, export_lights=False, export_animations=False)
        # Thumbnail: three-quarter view, transparent background. Atlas props render in
        # workbench with texture colors; glTF props in EEVEE, which also shows vertex tints.
        scene = bpy.context.scene
        if atlas:
            scene.render.engine = "BLENDER_WORKBENCH"
            scene.display.shading.color_type = "TEXTURE"
            scene.display.shading.light = "STUDIO"
        else:
            scene.render.engine = "BLENDER_EEVEE"
            scene.eevee.taa_render_samples = 16
            world = bpy.data.worlds.new("Studio")
            world.use_nodes = True
            world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.9, 0.9, 0.92, 1)
            world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
            scene.world = world
            sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
            sun.data.energy = 2.5
            sun.rotation_euler = (math.radians(50), 0, math.radians(30))
            scene.collection.objects.link(sun)
            scene.view_settings.view_transform = "Standard"
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
