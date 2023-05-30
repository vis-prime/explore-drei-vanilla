/** Author: @N8Programs https://github.com/N8python
 *    https://github.com/N8python/caustics
 */
import { shaderMaterial } from '@pmndrs/vanilla'
import {
  Color,
  FloatType,
  FrontSide,
  LinearEncoding,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  MeshNormalMaterial,
  RGBAFormat,
  ShaderMaterial,
  Texture,
  UnsignedByteType,
  Vector3,
} from 'three'

type CausticsMaterialType = ShaderMaterial & {
  cameraMatrixWorld?: Matrix4
  cameraProjectionMatrixInv?: Matrix4
  lightPlaneNormal?: Vector3
  lightPlaneConstant?: number
  normalTexture?: Texture | null
  depthTexture?: Texture | null
  lightDir?: Vector3
  near?: number
  far?: number
  modelMatrix?: Matrix4
  worldRadius?: number
  ior?: number
  bounces?: number
  resolution?: number
  size?: number
  intensity?: number
}

type CausticsProjectionMaterialType = MeshNormalMaterial & {
  viewMatrix: { value?: Matrix4 }
  color?: Color
  causticsTexture?: Texture
  causticsTextureB?: Texture
  lightProjMatrix?: Matrix4
  lightViewMatrix?: Matrix4
}

type CausticsProps = {
  /** How many frames it will render, set it to Infinity for runtime, default: 1 */
  frames?: number
  /** Enables visual cues to help you stage your scene, default: false */
  debug?: boolean
  /** Will display caustics only and skip the models, default: false */
  causticsOnly: boolean
  /** Will include back faces and enable the backsideIOR prop, default: false */
  backside: boolean
  /** The IOR refraction index, default: 1.1 */
  ior?: number
  /** The IOR refraction index for back faces (only available when backside is enabled), default: 1.1 */
  backsideIOR?: number
  /** The texel size, default: 0.3125 */
  worldRadius?: number
  /** Intensity of the prjected caustics, default: 0.05 */
  intensity?: number
  /** Caustics color, default: white */
  color?: Color
  /** Buffer resolution, default: 2048 */
  resolution?: number
  /** Camera position, it will point towards the contents bounds center, default: [5, 5, 5] */
  lightSource?: [x: number, y: number, z: number]
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      causticsProjectionMaterial:
        | any
        | MeshNormalMaterial
        | {
            viewMatrix?: { value: Matrix4 }
            color?: Color
            causticsTexture?: Texture
            causticsTextureB?: Texture
            lightProjMatrix?: Matrix4
            lightViewMatrix?: Matrix4
          }
    }
  }
}

function createNormalMaterial(side = FrontSide) {
  const viewMatrix = { value: new Matrix4() }
  return Object.assign(new MeshNormalMaterial({ side }) as CausticsProjectionMaterialType, {
    viewMatrix,
    onBeforeCompile: (shader) => {
      shader.uniforms.viewMatrix = viewMatrix
      shader.fragmentShader =
        `vec3 inverseTransformDirection( in vec3 dir, in mat4 matrix ) {
             return normalize( ( vec4( dir, 0.0 ) * matrix ).xyz );
           }\n` +
        shader.fragmentShader.replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
             normal = inverseTransformDirection( normal, viewMatrix );\n`
        )
    },
  })
}

const CausticsProjectionMaterial = shaderMaterial(
  {
    causticsTexture: null,
    causticsTextureB: null,
    color: new Color(),
    lightProjMatrix: new Matrix4(),
    lightViewMatrix: new Matrix4(),
  },
  `varying vec3 vWorldPosition;   
     void main() {
       gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.);
       vec4 worldPosition = modelMatrix * vec4(position, 1.);
       vWorldPosition = worldPosition.xyz;
     }`,
  `varying vec3 vWorldPosition;
    uniform vec3 color;
    uniform sampler2D causticsTexture; 
    uniform sampler2D causticsTextureB; 
    uniform mat4 lightProjMatrix;
    uniform mat4 lightViewMatrix;
     void main() {
      // Apply caustics  
      vec4 lightSpacePos = lightProjMatrix * lightViewMatrix * vec4(vWorldPosition, 1.0);
      lightSpacePos.xyz /= lightSpacePos.w;
      lightSpacePos.xyz = lightSpacePos.xyz * 0.5 + 0.5; 
      vec3 front = texture2D(causticsTexture, lightSpacePos.xy).rgb;
      vec3 back = texture2D(causticsTextureB, lightSpacePos.xy).rgb;
      gl_FragColor = vec4((front + back) * color, 1.0);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
     }`
)

const CausticsMaterial = shaderMaterial(
  {
    cameraMatrixWorld: new Matrix4(),
    cameraProjectionMatrixInv: new Matrix4(),
    normalTexture: null,
    depthTexture: null,
    lightDir: new Vector3(0, 1, 0),
    lightPlaneNormal: new Vector3(0, 1, 0),
    lightPlaneConstant: 0,
    near: 0.1,
    far: 100,
    modelMatrix: new Matrix4(),
    worldRadius: 1 / 40,
    ior: 1.1,
    bounces: 0,
    resolution: 1024,
    size: 10,
    intensity: 0.5,
  },
  /* glsl */ `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  /* glsl */ `  
    uniform mat4 cameraMatrixWorld;
    uniform mat4 cameraProjectionMatrixInv;
    uniform vec3 lightDir;
    uniform vec3 lightPlaneNormal;
    uniform float lightPlaneConstant;
    uniform float near;
    uniform float far;
    uniform float time;
    uniform float worldRadius;
    uniform float resolution;
    uniform float size;
    uniform float intensity;
    uniform float ior;
    precision highp isampler2D;
    precision highp usampler2D;
    uniform sampler2D normalTexture;
    uniform sampler2D depthTexture;
    uniform float bounces;
    varying vec2 vUv;
    vec3 WorldPosFromDepth(float depth, vec2 coord) {
      float z = depth * 2.0 - 1.0;
      vec4 clipSpacePosition = vec4(coord * 2.0 - 1.0, z, 1.0);
      vec4 viewSpacePosition = cameraProjectionMatrixInv * clipSpacePosition;
      // Perspective division
      viewSpacePosition /= viewSpacePosition.w;
      vec4 worldSpacePosition = cameraMatrixWorld * viewSpacePosition;
      return worldSpacePosition.xyz;
    }                  
    float sdPlane( vec3 p, vec3 n, float h ) {
      // n must be normalized
      return dot(p,n) + h;
    }
    float planeIntersect( vec3 ro, vec3 rd, vec4 p ) {
      return -(dot(ro,p.xyz)+p.w)/dot(rd,p.xyz);
    }
    vec3 totalInternalReflection(vec3 ro, vec3 rd, vec3 pos, vec3 normal, float ior, out vec3 rayOrigin, out vec3 rayDirection) {
      rayOrigin = ro;
      rayDirection = rd;
      rayDirection = refract(rayDirection, normal, 1.0 / ior);
      rayOrigin = pos + rayDirection * 0.1;
      return rayDirection;
    }
    void main() {
      // Each sample consists of random offset in the x and y direction
      float caustic = 0.0;
      float causticTexelSize = (1.0 / resolution) * size * 2.0;
      float texelsNeeded = worldRadius / causticTexelSize;
      float sampleRadius = texelsNeeded / resolution;
      float sum = 0.0;
      if (texture2D(depthTexture, vUv).x == 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      vec2 offset1 = vec2(-0.5, -0.5);//vec2(rand() - 0.5, rand() - 0.5);
      vec2 offset2 = vec2(-0.5, 0.5);//vec2(rand() - 0.5, rand() - 0.5);
      vec2 offset3 = vec2(0.5, 0.5);//vec2(rand() - 0.5, rand() - 0.5);
      vec2 offset4 = vec2(0.5, -0.5);//vec2(rand() - 0.5, rand() - 0.5);
      vec2 uv1 = vUv + offset1 * sampleRadius;
      vec2 uv2 = vUv + offset2 * sampleRadius;
      vec2 uv3 = vUv + offset3 * sampleRadius;
      vec2 uv4 = vUv + offset4 * sampleRadius;
      vec3 normal1 = texture2D(normalTexture, uv1, -10.0).rgb * 2.0 - 1.0;
      vec3 normal2 = texture2D(normalTexture, uv2, -10.0).rgb * 2.0 - 1.0;
      vec3 normal3 = texture2D(normalTexture, uv3, -10.0).rgb * 2.0 - 1.0;
      vec3 normal4 = texture2D(normalTexture, uv4, -10.0).rgb * 2.0 - 1.0;
      float depth1 = texture2D(depthTexture, uv1, -10.0).x;
      float depth2 = texture2D(depthTexture, uv2, -10.0).x;
      float depth3 = texture2D(depthTexture, uv3, -10.0).x;
      float depth4 = texture2D(depthTexture, uv4, -10.0).x;
      // Sanity check the depths
      if (depth1 == 1.0 || depth2 == 1.0 || depth3 == 1.0 || depth4 == 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      vec3 pos1 = WorldPosFromDepth(depth1, uv1);
      vec3 pos2 = WorldPosFromDepth(depth2, uv2);
      vec3 pos3 = WorldPosFromDepth(depth3, uv3);
      vec3 pos4 = WorldPosFromDepth(depth4, uv4);
      vec3 originPos1 = WorldPosFromDepth(0.0, uv1);
      vec3 originPos2 = WorldPosFromDepth(0.0, uv2);
      vec3 originPos3 = WorldPosFromDepth(0.0, uv3);
      vec3 originPos4 = WorldPosFromDepth(0.0, uv4);
      vec3 endPos1, endPos2, endPos3, endPos4;
      vec3 endDir1, endDir2, endDir3, endDir4;
      totalInternalReflection(originPos1, lightDir, pos1, normal1, ior, endPos1, endDir1);
      totalInternalReflection(originPos2, lightDir, pos2, normal2, ior, endPos2, endDir2);
      totalInternalReflection(originPos3, lightDir, pos3, normal3, ior, endPos3, endDir3);
      totalInternalReflection(originPos4, lightDir, pos4, normal4, ior, endPos4, endDir4);
      float lightPosArea = length(cross(originPos2 - originPos1, originPos3 - originPos1)) + length(cross(originPos3 - originPos1, originPos4 - originPos1));
      float t1 = planeIntersect(endPos1, endDir1, vec4(lightPlaneNormal, lightPlaneConstant));
      float t2 = planeIntersect(endPos2, endDir2, vec4(lightPlaneNormal, lightPlaneConstant));
      float t3 = planeIntersect(endPos3, endDir3, vec4(lightPlaneNormal, lightPlaneConstant));
      float t4 = planeIntersect(endPos4, endDir4, vec4(lightPlaneNormal, lightPlaneConstant));
      vec3 finalPos1 = endPos1 + endDir1 * t1;
      vec3 finalPos2 = endPos2 + endDir2 * t2;
      vec3 finalPos3 = endPos3 + endDir3 * t3;
      vec3 finalPos4 = endPos4 + endDir4 * t4;
      float finalArea = length(cross(finalPos2 - finalPos1, finalPos3 - finalPos1)) + length(cross(finalPos3 - finalPos1, finalPos4 - finalPos1));
      caustic += intensity * (lightPosArea / finalArea);
      // Calculate the area of the triangle in light spaces
      gl_FragColor = vec4(vec3(max(caustic, 0.0)), 1.0);
    }`
)

const NORMAL_PROPS = {
  depth: true,
  minFilter: LinearFilter,
  magFilter: LinearFilter,
  colorSpace: LinearEncoding,
  type: UnsignedByteType,
}

const CAUSTIC_PROPS = {
  minFilter: LinearMipmapLinearFilter,
  magFilter: LinearFilter,
  colorSpace: LinearEncoding,
  format: RGBAFormat,
  type: FloatType,
  generateMipmaps: true,
}

export {
  createNormalMaterial,
  CausticsProjectionMaterial,
  CausticsProjectionMaterialType,
  CausticsProps,
  CausticsMaterial,
  CausticsMaterialType,
  NORMAL_PROPS,
  CAUSTIC_PROPS,
}
