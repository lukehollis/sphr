
![sphr_logo](https://github.com/user-attachments/assets/bcc6126e-4c6d-48ec-ac76-7018d6149043)


# SPHR - SPatial Hackable Reality 


SPHR is an open-source virtual tour and digital twin builder that enables the creation of customizable 3D spaces shared in web browsers. 

Built with Three.js, it allows you to build interactive virtual experiences with full control over the environment, transitions, vfx, and other user interactions.


## Features
- Custom 3D space navigation and transitions
- Support for multiple viewing modes (First Person, Orbit)
- Integration with Matterport spaces
- Customizable tour points and annotations
- Mobile-responsive design
- Multi-language support


### 360 imagery 

Any sort of equirectangular 360 image can be used and displayed in the EnvCube component, but greater than 8k resolution is recommended. [EnvCube.js](https://github.com/lukehollis/sphr/blob/main/src/components/EnvCube.js)

There are two envCubes to support transition between the visible 360 image and the next that is navigated to. More on this in a later section.

In this implementation, to progressively load low-to-high resolution textures on the faces of the cube, I've used a IIIF image server for interoperability between projects. I'll remove this in future versions. 


### Cursor

One of the most essential pieces of this implementation is the cursor that renders on the 3d mesh of the space but appears on the top of the 360 images. This is where your users get the photorealistic 3d experience, interacting with the 3d mesh but viewing the 360 images.

You can see the current implementation here: [Cursor.js](https://github.com/lukehollis/sphr/blob/main/src/components/Cursor.js). There are many optimization to be made with the cursor, but it is currently functional as seen in the demos, and can be used as a starting point for your own custom cursor.



### Dollhouse 

The dollhouse is the low resolution version of a 3d capture of your space [Dollhouse.js](https://github.com/lukehollis/sphr/blob/main/src/components/Dollhouse.js)

It's used for cursor interactions and the Orbit view mode. I generally aim for less than 50k verts in my dollhouse and less than 2MB in texture size, but you can use much larger if it's important for you.


### Transition between 360 images w/CubeRenderTarget

This is a complex interaction that has little documentation in other place online--and one of the main reasons why I thought it would be useful to release this code. 

When navigating between two 360 images, the main camera lerps between the position of your first 360 image and second 360 image, and uses a [WebGLCubeRenderTarget](https://threejs.org/docs/#api/en/renderers/WebGLCubeRenderTarget) to render the transition onto the Environment Map of the Dollhouse to simulate movement between two points. 

This is an atypical custom use of the envMap, more here at (MeshBasicMaterial](https://threejs.org/docs/#api/en/materials/MeshBasicMaterial). The current implementation is memory inefficient and requires further work in custom shader development. 


### Models 

Unlike other tour builder software, this implementation offers a fully customizable scene graph to allow for changing between spaces and items in focus. You can customize this in the space and tour files in the next section.

You can see both [SceneGraph.js](https://github.com/lukehollis/sphr/blob/main/src/components/SceneGraph.js) for 3d models and [AnnotationGraph.js](https://github.com/lukehollis/sphr/blob/main/src/components/AnnotationGraph.js) for 2d annotations such as images and video embedded in your scenes.


### Spacefile / Building tours

To build your spaces and tours, reference the [example_space.json](https://github.com/lukehollis/sphr/blob/main/data/example_space.json) and [example_tour.json] in the `data` directory. 

These use the Nefertari dataset to demonstrate the expected format of the data required by the frontend. 


### Space JSON Format

#### Nodes Array
Each node in the `nodes` array represents a viewpoint in the 3D space and contains:
- `uuid`: Unique identifier for the node
- `image`: Path to the 360° image for this viewpoint
- `index`: Numeric index of the node
- `position`: 3D coordinates (x,y,z) for camera position
- `rotation`: Rotation angles (x,y,z) in radians
- `resolution`: Image resolution (e.g. "4096")
- `floorPosition`: 3D coordinates (x,y,z) for position on floor

#### Scene Settings
The `sceneSettings` object contains configuration for:

##### Nodes Settings
- `scale`: Scale factor for node group
- `offsetPosition`: Position offset (x,y,z)
- `offsetRotation`: Rotation offset (x,y,z)

##### Dollhouse Settings
- `scale`: Scale factor for dollhouse model
- `offsetPosition`: Position offset (x,y,z)
- `offsetRotation`: Rotation offset (x,y,z)

##### Global Offsets
- `offsetPosition`: Global position offset
- `offsetRotation`: Global rotation offset

#### Initial Settings
- `initialNode`: UUID of starting node
- `initialRotation`: Starting camera rotation
  - `polar`: Polar angle in degrees
  - `azimuth`: Azimuth angle in degrees

This format allows defining a complete 3D space with multiple viewpoints, their positions, rotations, and global scene settings. The data is used by the application to render the 3D environment and handle navigation between viewpoints.


### Tour JSON Format

#### Audio Configuration
The `audio` object defines different audio tracks and their settings:
- `start`: Audio played at tour start
- `default`: Background music/audio
- `navigate`: Sound effect for navigation
Each audio entry contains:
- `url`: Path to audio file
- `options`: 
  - `loop`: Boolean for looping
  - `volume`: Value between 0-1
  - `autoplay`: Boolean to autoplay

#### Spaces Array
Each space in the `spaces` array contains:
- `id`: Unique identifier for the space
- `url`: URL to the space (optional)
- `type`: Type of space (e.g. "spaces")
- `title`: Display title for the space
- `tourpoints`: Array of navigation points

#### Tourpoints
Each tourpoint defines a stop in the tour:
- `pan`: Direction of camera movement ("left", "right")
- `text`: Main descriptive text
- `zoom`: Camera zoom level (0-100)
- `files`: Array of associated files
- `models`: Array of 3D model IDs to display
- `sounds`: Array of audio IDs to play
- `nodeUUID`: ID of the node to move to
- `rotation`: Camera rotation
  - `polar`: Vertical angle in degrees
  - `azimuth`: Horizontal angle in degrees
- `viewMode`: View mode ("FPV" or "ORBIT")
- `targetType`: Type of target ("NODE" or "MODEL")
- `annotations`: Array of annotations
- `textPosition`: Position of text overlay
- `secondaryText`: Additional text (optional)

#### Scene Graph
Array of 3D models that can be shown during the tour. Each model has:
- `id`: Unique identifier
- `file`: URL to model file
- `type`: Type of asset ("model")
- `scale`: Array of [x,y,z] scale factors
- `fileType`: Format of model file
- `isSketch`: Boolean for sketch rendering
- `position`: Array of [x,y,z] coordinates
- `rotation`: Array of [x,y,z] rotation angles

#### Global Settings
- `autoplay`: Boolean to auto-advance tour
- `nextTour`: ID of next tour or "random"
- `defaultShowText`: Boolean to show text by default





https://github.com/user-attachments/assets/1fb89081-50bf-459d-b1cf-75f672ebc3e7




### 3d Gaussian Splatting Support

This supports out of the box FPV exploration of 3d Gaussian Splats using [@mkkellogg](https://github.com/mkkellogg)'s excellent [Three.js splat implementation](https://github.com/mkkellogg/GaussianSplats3D) and adding the custom cursor and tour support. 



## Building

Building for different languages:
You can build for a specific language by setting the LANG environment variable:

```bash
LANG=en npm run build  # for English
LANG=ar npm run build  # for Arabic
LANG=es npm run build  # for Spanish
```


## Development
1. Clone the repository
2. Install dependencies: `npm install`
3. Start development server: `npm run start`
4. Build for production: `npm run build`

## Customization
The project is designed to be highly customizable. You can:
- Add custom scene effects and transitions
- Implement your own tour navigation logic
- Create custom UI components
- Extend the annotation system
- Add new language support

## License
MIT, but if this is useful to you, I request that you cite this repo because it helps the work continue.

```
@misc{hollis2024sphr,
  author = {Luke Hollis},
  title = {SPHR - Spatial Human Reality in a web browser},
  year = {2024},
  publisher = {GitHub},
  journal = {GitHub repository},
  howpublished = {\url{https://github.com/lukehollis/sphr}}
}
```
