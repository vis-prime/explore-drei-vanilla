import * as THREE from 'three'
import { useIntersect } from './useIntersect'
import { useFBO } from './useFBO'
import { RenderTexture } from './RenderTexture'
import { shaderMaterial } from '@pmndrs/vanilla'
import { FullScreenQuad } from 'three-stdlib'

const PortalMaterialImpl = shaderMaterial(
  {
    blur: 0,
    map: null,
    sdf: null,
    blend: 0,
    size: 0,
    resolution: new THREE.Vector2(),
  },
  `varying vec2 vUv;
     void main() {
       gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
       vUv = uv;
     }`,
  `uniform sampler2D sdf;
     uniform sampler2D map;
     uniform float blur;
     uniform float size;
     uniform float time;
     uniform vec2 resolution;
     varying vec2 vUv;
     #include <packing>
     void main() {
       vec2 uv = gl_FragCoord.xy / resolution.xy;
       vec4 t = texture2D(map, uv);
       float k = blur;
       float d = texture2D(sdf, vUv).r/size;
       float alpha = 1.0 - smoothstep(0.0, 1.0, clamp(d/k + 1.0, 0.0, 1.0));
       gl_FragColor = vec4(t.rgb, blur == 0.0 ? t.a : t.a * alpha);
       #include <tonemapping_fragment>
       #include <encodings_fragment>
     }`
)

export const MeshPortalMaterial = (
  scene: THREE.Scene,
  gl: THREE.WebGLRenderer,
  size: { width: number; height: number },
  viewport: { dpr: number },
  setEvents: (arg0: { enabled: boolean }) => void,
  {
    // children,
    events = undefined,
    blur = 0,
    eventPriority = 0,
    renderPriority = 0,
    worldUnits = false,
    resolution = 512,
    ...props
  } = {}
) => {
  const ref = { current: new PortalMaterialImpl({ blur, resolution, toneMapped: false }) }
  //   const { scene, gl, size, viewport, setEvents }
  const maskRenderTarget = useFBO(resolution, resolution)

  let priority = 0
  const setPriority = (v: number) => {
    priority = v
  }

  const update = () => {
    // If blend is > 0 then the portal is being entered, the render-priority must change
    const p = ref.current.blend > 0 ? Math.max(1, renderPriority) : 0
    if (priority !== p) setPriority(p)
  }

  const onEventChange = () => {
    if (events !== undefined) setEvents({ enabled: !events })
  }

  let visible = true
  const setVisible = (v: boolean) => {
    visible = v
  }

  // See if the parent mesh is in the camera frustum
  const parent = new useIntersect(setVisible)
  console.log({ parent })
  parent.material = ref
  //   const init = () => {
  //     // Since the ref above is not tied to a mesh directly (we're inside a material),
  //     // it has to be tied to the parent mesh here
  //     parent.current = (ref.current as any)?.__r3f.parent
  //   }

  const OnResolutionBlurChange = () => {
    if (!parent.current) return

    // Apply the SDF mask only once
    if (blur && ref.current.sdf === null) {
      const tempMesh = new THREE.Mesh(parent.current.geometry, new THREE.MeshBasicMaterial())
      const boundingBox = new THREE.Box3().setFromBufferAttribute(
        tempMesh.geometry.attributes.position as THREE.BufferAttribute
      )
      const orthoCam = new THREE.OrthographicCamera(
        boundingBox.min.x * (1 + 2 / resolution),
        boundingBox.max.x * (1 + 2 / resolution),
        boundingBox.max.y * (1 + 2 / resolution),
        boundingBox.min.y * (1 + 2 / resolution),
        0.1,
        1000
      )
      orthoCam.position.set(0, 0, 1)
      orthoCam.lookAt(0, 0, 0)

      gl.setRenderTarget(maskRenderTarget)
      gl.render(tempMesh, orthoCam)
      const sg = makeSDFGenerator(resolution, resolution, gl)
      const sdf = sg(maskRenderTarget.texture)
      const readSdf = new Float32Array(resolution * resolution)
      gl.readRenderTargetPixels(sdf, 0, 0, resolution, resolution, readSdf)
      // Get smallest value in sdf
      let min = Infinity
      for (let i = 0; i < readSdf.length; i++) {
        if (readSdf[i] < min) min = readSdf[i]
      }
      min = -min
      ref.current.size = min
      ref.current.sdf = sdf.texture

      gl.setRenderTarget(null)
    }
  }

  //   React.useImperativeHandle(fref, () => ref.current)

  const compute = (event, state, previous) => {
    if (!parent.current) return false
    state.pointer.set((event.offsetX / state.size.width) * 2 - 1, -(event.offsetY / state.size.height) * 2 + 1)
    state.raycaster.setFromCamera(state.pointer, state.camera)

    if (ref.current?.blend === 0) {
      // We run a quick check against the parent, if it isn't hit there's no need to raycast at all
      const [intersection] = state.raycaster.intersectObject(parent.current)
      if (!intersection) {
        // Cancel out the raycast camera if the parent mesh isn't hit
        state.raycaster.camera = undefined
        return false
      }
    }
  }

  const PORTAL_DICT = {
    portalMaterial: ref,
  }

  return PORTAL_DICT

  //   return (
  //     <portalMaterialImpl
  //       ref={ref}
  //       blur={blur}
  //       blend={0}
  //       resolution={[size.width * viewport.dpr, size.height * viewport.dpr]}
  //       toneMapped={false}
  //       attach="material"
  //       {...props}
  //     >
  //       <RenderTexture
  //         attach="map"
  //         frames={visible ? Infinity : 0}
  //         eventPriority={eventPriority}
  //         renderPriority={renderPriority}
  //         compute={compute}
  //       >
  //         {children}
  //         <CopyMatrix events={events} rootScene={scene} priority={priority} material={ref} worldUnits={worldUnits} />
  //       </RenderTexture>
  //     </portalMaterialImpl>
  //   )
}

function CopyMatrix(
  scene: THREE.Scene,
  gl: THREE.WebGLRenderer,
  camera: THREE.Camera,
  obj: THREE.Object3D,
  {
    events = undefined,
    rootScene,
    material,
    priority,
    worldUnits,
  }: {
    events?: boolean
    rootScene: THREE.Scene
    material: PortalMaterialType
    priority: number
    worldUnits: boolean
  }
) {
  // const scene = useThree((state) => state.scene)
  const setEvents = (s: boolean) => {
    events = s
  }
  const buffer1 = useFBO()
  const buffer2 = useFBO()

  const state = { gl, camera }

  const init = () => {
    scene.matrixAutoUpdate = false
  }

  const onEventChange = () => {
    if (events !== undefined) setEvents(events)
  }

  const createQuadAndBlend = () => {
    // This fullscree-quad is used to blend the two textures
    const blend = { value: 0 }
    const quad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: {
          a: { value: buffer1.texture },
          b: { value: buffer2.texture },
          blend,
        },
        vertexShader: /*glsl*/ `
            varying vec2 vUv;
            void main() {
              vUv = uv;
              gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
            }`,
        fragmentShader: /*glsl*/ `
            uniform sampler2D a;
            uniform sampler2D b;
            uniform float blend;
            varying vec2 vUv;
            #include <packing>
            void main() {
              vec4 ta = texture2D(a, vUv);
              vec4 tb = texture2D(b, vUv);
              gl_FragColor = mix(tb, ta, blend);
              #include <encodings_fragment>
            }`,
      })
    )
    return [quad, blend]
  }

  const [quad, blend] = createQuadAndBlend()

  const updatePriority = () => {
    let parent = obj.parent
    if (parent) {
      if (!worldUnits) scene.matrixWorld.copy(parent.matrixWorld)
      else scene.matrixWorld.identity()

      if (priority) {
        if (material.current?.blend > 0 && material.current?.blend < 1 && parent) {
          blend.value = material.current.blend
          state.gl.setRenderTarget(buffer1)
          state.gl.render(scene, state.camera)
          state.gl.setRenderTarget(buffer2)
          state.gl.render(rootScene, state.camera)
          state.gl.setRenderTarget(null)
          quad.render(state.gl)
        } else if (material.current?.blend === 1) {
          state.gl.render(scene, state.camera)
        }
      }
    }
  }
}

const makeSDFGenerator = (clientWidth, clientHeight, renderer) => {
  let finalTarget = new THREE.WebGLRenderTarget(clientWidth, clientHeight, {
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.FloatType,
    format: THREE.RedFormat,
    generateMipmaps: true,
  })
  let outsideRenderTarget = new THREE.WebGLRenderTarget(clientWidth, clientHeight, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  })
  let insideRenderTarget = new THREE.WebGLRenderTarget(clientWidth, clientHeight, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  })
  let outsideRenderTarget2 = new THREE.WebGLRenderTarget(clientWidth, clientHeight, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  })
  let insideRenderTarget2 = new THREE.WebGLRenderTarget(clientWidth, clientHeight, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  })
  let outsideRenderTargetFinal = new THREE.WebGLRenderTarget(clientWidth, clientHeight, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    type: THREE.FloatType,
    format: THREE.RedFormat,
  })
  let insideRenderTargetFinal = new THREE.WebGLRenderTarget(clientWidth, clientHeight, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    type: THREE.FloatType,
    format: THREE.RedFormat,
  })
  const uvRender = new FullScreenQuad(
    new THREE.ShaderMaterial({
      uniforms: { tex: { value: null } },
      vertexShader: /*glsl*/ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
          }`,
      fragmentShader: /*glsl*/ `
          uniform sampler2D tex;
          varying vec2 vUv;
          #include <packing>
          void main() {
            gl_FragColor = pack2HalfToRGBA(vUv * (round(texture2D(tex, vUv).x)));
          }`,
    })
  )
  const uvRenderInside = new FullScreenQuad(
    new THREE.ShaderMaterial({
      uniforms: { tex: { value: null } },
      vertexShader: /*glsl*/ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
          }`,
      fragmentShader: /*glsl*/ `
          uniform sampler2D tex;
          varying vec2 vUv;
          #include <packing>
          void main() {
            gl_FragColor = pack2HalfToRGBA(vUv * (1.0 - round(texture2D(tex, vUv).x)));
          }`,
    })
  )
  const jumpFloodRender = new FullScreenQuad(
    new THREE.ShaderMaterial({
      uniforms: {
        tex: { value: null },
        offset: { value: 0.0 },
        level: { value: 0.0 },
        maxSteps: { value: 0.0 },
      },
      vertexShader: /*glsl*/ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
          }`,
      fragmentShader: /*glsl*/ `
          varying vec2 vUv;
          uniform sampler2D tex;
          uniform float offset;
          uniform float level;
          uniform float maxSteps;
          #include <packing>
          void main() {
            float closestDist = 9999999.9;
            vec2 closestPos = vec2(0.0);
            for (float x = -1.0; x <= 1.0; x += 1.0) {
              for (float y = -1.0; y <= 1.0; y += 1.0) {
                vec2 voffset = vUv;
                voffset += vec2(x, y) * vec2(${1 / clientWidth}, ${1 / clientHeight}) * offset;
                vec2 pos = unpackRGBATo2Half(texture2D(tex, voffset));
                float dist = distance(pos.xy, vUv);
                if(pos.x != 0.0 && pos.y != 0.0 && dist < closestDist) {
                  closestDist = dist;
                  closestPos = pos;
                }
              }
            }
            gl_FragColor = pack2HalfToRGBA(closestPos);
          }`,
    })
  )
  const distanceFieldRender = new FullScreenQuad(
    new THREE.ShaderMaterial({
      uniforms: {
        tex: { value: null },
        size: { value: new THREE.Vector2(clientWidth, clientHeight) },
      },
      vertexShader: /*glsl*/ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
          }`,
      fragmentShader: /*glsl*/ `
          varying vec2 vUv;
          uniform sampler2D tex;
          uniform vec2 size;
          #include <packing>
          void main() {
            gl_FragColor = vec4(distance(size * unpackRGBATo2Half(texture2D(tex, vUv)), size * vUv), 0.0, 0.0, 0.0);
          }`,
    })
  )
  const compositeRender = new FullScreenQuad(
    new THREE.ShaderMaterial({
      uniforms: {
        inside: { value: insideRenderTargetFinal.texture },
        outside: { value: outsideRenderTargetFinal.texture },
        tex: { value: null },
      },
      vertexShader: /*glsl*/ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
          }`,
      fragmentShader: /*glsl*/ `
          varying vec2 vUv;
          uniform sampler2D inside;
          uniform sampler2D outside;
          uniform sampler2D tex;
          #include <packing>
          void main() {
            float i = texture2D(inside, vUv).x;
            float o =texture2D(outside, vUv).x;
            if (texture2D(tex, vUv).x == 0.0) {
              gl_FragColor = vec4(o, 0.0, 0.0, 0.0);
            } else {
              gl_FragColor = vec4(-i, 0.0, 0.0, 0.0);
            }
          }`,
    })
  )

  return (image: THREE.Texture) => {
    let ft = finalTarget
    image.minFilter = THREE.NearestFilter
    image.magFilter = THREE.NearestFilter
    uvRender.material.uniforms.tex.value = image
    renderer.setRenderTarget(outsideRenderTarget)
    uvRender.render(renderer)

    const passes = Math.ceil(Math.log(Math.max(clientWidth, clientHeight)) / Math.log(2.0))
    let lastTarget = outsideRenderTarget
    let target: THREE.WebGLRenderTarget = null!
    for (let i = 0; i < passes; i++) {
      const offset = Math.pow(2, passes - i - 1)
      target = lastTarget === outsideRenderTarget ? outsideRenderTarget2 : outsideRenderTarget
      jumpFloodRender.material.uniforms.level.value = i
      jumpFloodRender.material.uniforms.maxSteps.value = passes
      jumpFloodRender.material.uniforms.offset.value = offset
      jumpFloodRender.material.uniforms.tex.value = lastTarget.texture
      renderer.setRenderTarget(target)
      jumpFloodRender.render(renderer)
      lastTarget = target
    }
    renderer.setRenderTarget(outsideRenderTargetFinal)
    distanceFieldRender.material.uniforms.tex.value = target.texture
    distanceFieldRender.render(renderer)
    uvRenderInside.material.uniforms.tex.value = image
    renderer.setRenderTarget(insideRenderTarget)
    uvRenderInside.render(renderer)
    lastTarget = insideRenderTarget

    for (let i = 0; i < passes; i++) {
      const offset = Math.pow(2, passes - i - 1)
      target = lastTarget === insideRenderTarget ? insideRenderTarget2 : insideRenderTarget
      jumpFloodRender.material.uniforms.level.value = i
      jumpFloodRender.material.uniforms.maxSteps.value = passes
      jumpFloodRender.material.uniforms.offset.value = offset
      jumpFloodRender.material.uniforms.tex.value = lastTarget.texture
      renderer.setRenderTarget(target)
      jumpFloodRender.render(renderer)
      lastTarget = target
    }
    renderer.setRenderTarget(insideRenderTargetFinal)
    distanceFieldRender.material.uniforms.tex.value = target.texture
    distanceFieldRender.render(renderer)
    renderer.setRenderTarget(ft)
    compositeRender.material.uniforms.tex.value = image
    compositeRender.render(renderer)
    renderer.setRenderTarget(null)
    return ft
  }
}
