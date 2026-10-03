// Google's Draco decoder for Node (Apache-2.0), used to read compressed capture meshes.
declare module "draco3dgltf" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const draco3d: { createDecoderModule(options?: object): Promise<any> };
  export default draco3d;
}
