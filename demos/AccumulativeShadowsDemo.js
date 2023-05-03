import {
  ACESFilmicToneMapping,
  EquirectangularReflectionMapping,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  WebGLRenderer,
  Vector2,
  Raycaster,
  Group,
  BoxGeometry,
  Color,
  PlaneGeometry,
  DirectionalLight,
  MathUtils,
  Vector3,
} from 'three'
import Stats from 'three/examples/jsm/libs/stats.module'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls'
import { MODEL_LIST } from '../models/MODEL_LIST'
import { HDRI_LIST } from '../hdri/HDRI_LIST'
import { ProgressiveLightMap, SoftShadowMaterial } from '../wip/AccumulativeShadows'

let stats,
  renderer,
  raf,
  camera,
  scene,
  controls,
  gui,
  pointer = new Vector2()

const params = {
  bgColor: new Color(),
  printCam: () => {},
}
const mainObjects = new Group()
const rgbeLoader = new RGBELoader()
const gltfLoader = new GLTFLoader()
const draco = new DRACOLoader()
let transformControls
// draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.5/")
draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/')
gltfLoader.setDRACOLoader(draco)
const raycaster = new Raycaster()
const intersects = [] //raycast

let sceneGui

/**
 * @type {ProgressiveLightMap}
 */
let plm,
  /**
   * @type {Group}
   */
  gLights,
  /**
   * @type {Mesh}
   */
  gPlane

const shadowParams = {
  temporal: true,
  frames: 40,
  limit: Infinity,
  blend: 20,
  scale: 10,
  opacity: 1,
  alphaTest: 0.75,
  color: new Color('black'),
  colorBlend: 2,
  resolution: 2048,
  toneMapped: true,
}

const lightParams = {
  bias: 0.001,
  mapSize: 1024,
  size: 10,
  near: 0.5,
  far: 500,
  position: new Vector3(5, 5, 5),
  radius: 1,
  amount: 8,
  intensity: 1,
  ambient: 0.5,
}

const api = {
  lights: new Map(),
  temporal: !!shadowParams.temporal,
  frames: Math.max(2, shadowParams.frames),
  blend: Math.max(2, shadowParams.frames === Infinity ? shadowParams.blend : shadowParams.frames),
  count: 0,
  resetPlm: () => {
    reset()
  },
}

export async function AccumulativeShadowsDemo(mainGui) {
  gui = mainGui
  sceneGui = gui.addFolder('Scene')
  stats = new Stats()
  app.appendChild(stats.dom)
  // renderer
  renderer = new WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.shadowMap.enabled = true
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping

  app.appendChild(renderer.domElement)

  // camera
  camera = new PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200)
  camera.position.set(6, 3, 6)
  camera.name = 'Camera'

  // scene
  scene = new Scene()

  rgbeLoader.load(HDRI_LIST.skidpan.hdr, (texture) => {
    texture.mapping = EquirectangularReflectionMapping
    scene.backgroundBlurriness = 0.7
    scene.background = texture
    scene.environment = texture
  })
  scene.add(mainObjects)

  // controls
  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true // an animation loop is required when either damping or auto-rotation are enabled
  controls.dampingFactor = 0.05
  controls.minDistance = 0.1
  controls.maxDistance = 100
  controls.maxPolarAngle = Math.PI / 1.5
  controls.target.set(0, 0, 0)
  controls.target.set(0, 0, 0)

  transformControls = new TransformControls(camera, renderer.domElement)
  transformControls.addEventListener('dragging-changed', (event) => {
    controls.enabled = !event.value
    if (!event.value) {
      plm.recalculate()
    }
  })

  transformControls.addEventListener('change', () => {
    if (transformControls.object) {
      if (transformControls.object.position.y < 0) {
        transformControls.object.position.y = 0
      }
    }
  })
  // scene.add(transformControls)

  window.addEventListener('resize', onWindowResize)
  document.addEventListener('pointermove', onPointerMove)

  let downTime = Date.now()
  document.addEventListener('pointerdown', () => {
    downTime = Date.now()
  })
  document.addEventListener('pointerup', (e) => {
    if (Date.now() - downTime < 200) {
      onPointerMove(e)
      raycast()
    }
  })

  sceneGui.add(transformControls, 'mode', ['translate', 'rotate', 'scale'])
  sceneGui.add(scene, 'backgroundBlurriness', 0, 1, 0.01)
  sceneGui.addColor(params, 'bgColor').onChange(() => {
    scene.background = params.bgColor
  })

  initProgressiveShadows()
  await loadModels()
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}

function render() {
  stats.update()
  // Update the inertia on the orbit controls
  controls.update()

  accumulateShadows()

  renderer.render(scene, camera)
}

function animate() {
  raf = requestAnimationFrame(animate)
  render()
}

function raycast() {
  // update the picking ray with the camera and pointer position
  raycaster.setFromCamera(pointer, camera)

  // calculate objects intersecting the picking ray
  raycaster.intersectObject(mainObjects, true, intersects)

  if (!intersects.length) {
    transformControls.detach()
    return
  }

  transformControls.attach(intersects[0].object)

  intersects.length = 0
}

function onPointerMove(event) {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1
}

async function loadModels() {
  // sphere
  const sphere = new Mesh(
    new SphereGeometry(0.5).translate(0, 0.5, 0),
    new MeshStandardMaterial({ color: getRandomHexColor(), roughness: 0, metalness: 1 })
  )
  sphere.name = 'sphere'
  sphere.castShadow = true
  sphere.receiveShadow = true
  sphere.position.set(2, 0, -1.5)
  mainObjects.add(sphere)

  // cube
  const cube = new Mesh(
    new BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    new MeshStandardMaterial({ color: getRandomHexColor(), roughness: 0.3, metalness: 0 })
  )
  cube.name = 'cube'
  cube.castShadow = true
  cube.receiveShadow = true
  cube.position.set(-1.5, 0, 1.5)
  mainObjects.add(cube)

  // monkey
  const gltf = await gltfLoader.loadAsync(MODEL_LIST.monkey.url)
  const model = gltf.scene
  model.name = 'suzanne'
  model.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true
      child.receiveShadow = true
    }
  })
  mainObjects.add(model)

  // call this once all models are in scene
  plm.clear()

  animate()
}

function initProgressiveShadows() {
  plm = new ProgressiveLightMap(renderer, scene, shadowParams.resolution)

  // Material applied to shadow catching plane
  const shadowCatcherMaterial = new SoftShadowMaterial({
    map: plm.progressiveLightMap2.texture,
    transparent: true,
    depthWrite: false,
    toneMapped: shadowParams.toneMapped,
    color: shadowParams.color,
    blend: shadowParams.colorBlend,
  })

  // const shadowCatcherMaterial = new MeshStandardMaterial({
  //   map: plm.progressiveLightMap2.texture,
  // })

  gPlane = new Mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), shadowCatcherMaterial)
  gPlane.scale.setScalar(shadowParams.scale)
  gPlane.receiveShadow = true
  scene.add(gPlane)
  plm.configure(gPlane)

  gLights = new Group()

  // create 8 directional lights to speed up the convergence
  for (let l = 0; l < lightParams.amount; l++) {
    const dirLight = new DirectionalLight(0xffffff, lightParams.intensity / lightParams.amount)
    dirLight.name = 'dir_light_' + l
    dirLight.castShadow = true
    dirLight.shadow.bias = lightParams.bias
    dirLight.shadow.camera.near = lightParams.near
    dirLight.shadow.camera.far = lightParams.far
    dirLight.shadow.camera.right = lightParams.size / 2
    dirLight.shadow.camera.left = -lightParams.size / 2
    dirLight.shadow.camera.top = lightParams.size / 2
    dirLight.shadow.camera.bottom = -lightParams.size / 2
    dirLight.shadow.mapSize.width = lightParams.mapSize
    dirLight.shadow.mapSize.height = lightParams.mapSize
    gLights.add(dirLight)
  }

  addPlmGui(gui)
}

function randomiseLightPositions() {
  for (let i = 0; i < gLights.children.length; i++) {
    const light = gLights.children[i]
    if (Math.random() > lightParams.ambient) {
      light.position.set(
        lightParams.position.x + MathUtils.randFloatSpread(lightParams.radius),
        lightParams.position.y + MathUtils.randFloatSpread(lightParams.radius),
        lightParams.position.z + MathUtils.randFloatSpread(lightParams.radius)
      )
    } else {
      let lambda = Math.acos(2 * Math.random() - 1) - Math.PI / 2.0
      let phi = 2 * Math.PI * Math.random()
      light.position.set(
        Math.cos(lambda) * Math.cos(phi) * length,
        Math.abs(Math.cos(lambda) * Math.sin(phi) * length),
        Math.sin(lambda) * length
      )
    }
  }
}

function reset() {
  console.log('reset')
  plm.clear()
  lightParams.position.x = MathUtils.randFloatSpread(10)
  lightParams.position.y = MathUtils.randFloat(4, 5)
  lightParams.position.z = MathUtils.randFloatSpread(10)

  const material = gPlane.material
  material.opacity = 0
  material.alphaTest = 0
  api.count = 0
}

function accumulateShadows() {
  if ((api.temporal || api.frames === Infinity) && api.count < api.frames && api.count < shadowParams.limit) {
    update()
    api.count++
  }
}

function update(frames = 1) {
  // Adapt the opacity-blend ratio to the number of frames
  const material = gPlane.material
  if (!api.temporal) {
    material.opacity = shadowParams.opacity
    material.alphaTest = shadowParams.alphaTest
  } else {
    material.opacity = Math.min(shadowParams.opacity, material.opacity + shadowParams.opacity / api.blend)
    material.alphaTest = Math.min(shadowParams.alphaTest, material.alphaTest + shadowParams.alphaTest / api.blend)
  }

  // Switch accumulative lights on
  scene.add(gLights)
  // Collect scene lights and meshes
  plm.prepare()

  // Update the lightmap and the accumulative lights

  for (let i = 0; i < frames; i++) {
    // api.lights.forEach((light) => light.update())
    randomiseLightPositions()
    plm.update(camera, api.blend)
  }
  // Switch lights off
  scene.remove(gLights)
  // Restore lights and meshes
  plm.finish()
}

const color = new Color()
function getRandomHexColor() {
  return '#' + color.setHSL(Math.random(), 0.5, 0.5).getHexString()
}

function addPlmGui(gui) {
  const folder = gui.addFolder('plm')
  folder.open()
  folder.add(api, 'resetPlm')
}
