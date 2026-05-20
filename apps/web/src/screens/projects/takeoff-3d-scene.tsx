import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { TakeoffPreviewItem, TakeoffPreviewPoint, TakeoffPreviewScene } from '@/lib/takeoff/geometry-3d'

interface TakeoffThreeSceneProps {
  scene: TakeoffPreviewScene
  selectedId: string | null
  onSelect: (id: string | null) => void
}

export function TakeoffThreeScene({ scene, selectedId, onSelect }: TakeoffThreeSceneProps) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const onSelectRef = useRef(onSelect)

  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(0x0d1117, 1)
    renderer.domElement.dataset.testid = 'takeoff-preview-canvas'
    mount.appendChild(renderer.domElement)

    const threeScene = new THREE.Scene()
    threeScene.background = new THREE.Color(0x0d1117)

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000)
    const span = sceneSpan(scene)
    camera.position.set(0, Math.max(28, span * 0.75), Math.max(58, span * 1.05))
    camera.lookAt(0, 0, 0)

    const root = new THREE.Group()
    threeScene.add(root)

    const gridSize = Math.max(80, span * 1.35)
    const grid = new THREE.GridHelper(gridSize, 20, 0x3b4350, 0x242b36)
    root.add(grid)

    const ambient = new THREE.HemisphereLight(0xffffff, 0x18202b, 1.8)
    threeScene.add(ambient)
    const key = new THREE.DirectionalLight(0xffffff, 2.5)
    key.position.set(40, 80, 30)
    threeScene.add(key)

    const clickable: THREE.Object3D[] = []
    for (const item of scene.items) {
      const objects = buildItemObjects(item, item.id === selectedId)
      for (const object of objects) {
        object.userData.measurementId = item.id
        root.add(object)
        clickable.push(object)
      }
    }

    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const drag = { active: false, x: 0, y: 0, moved: 0 }

    const resize = () => {
      const rect = mount.getBoundingClientRect()
      const width = Math.max(1, rect.width)
      const height = Math.max(1, rect.height)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      render()
    }

    const render = () => renderer.render(threeScene, camera)

    const onPointerDown = (event: PointerEvent) => {
      drag.active = true
      drag.x = event.clientX
      drag.y = event.clientY
      drag.moved = 0
      renderer.domElement.setPointerCapture(event.pointerId)
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!drag.active) return
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      drag.x = event.clientX
      drag.y = event.clientY
      drag.moved += Math.abs(dx) + Math.abs(dy)
      root.rotation.y += dx * 0.008
      root.rotation.x = THREE.MathUtils.clamp(root.rotation.x + dy * 0.006, -0.7, 0.45)
      render()
    }

    const onPointerUp = (event: PointerEvent) => {
      drag.active = false
      if (drag.moved <= 5) {
        const rect = renderer.domElement.getBoundingClientRect()
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
        pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1)
        raycaster.setFromCamera(pointer, camera)
        const hit = raycaster.intersectObjects(clickable, true)[0]
        const id = findMeasurementId(hit?.object)
        onSelectRef.current(id)
      }
      try {
        renderer.domElement.releasePointerCapture(event.pointerId)
      } catch {
        // Ignore release races during unmount.
      }
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const scale = event.deltaY > 0 ? 1.08 : 0.92
      camera.position.multiplyScalar(scale)
      const distance = camera.position.length()
      if (distance < 18) camera.position.setLength(18)
      if (distance > 320) camera.position.setLength(320)
      camera.lookAt(0, 0, 0)
      render()
    }

    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('pointerup', onPointerUp)
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false })

    const observer = new ResizeObserver(resize)
    observer.observe(mount)
    resize()
    render()

    return () => {
      observer.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      renderer.domElement.removeEventListener('wheel', onWheel)
      mount.removeChild(renderer.domElement)
      disposeObject(root)
      grid.geometry.dispose()
      renderer.dispose()
    }
  }, [scene, selectedId])

  return (
    <div
      ref={mountRef}
      data-testid="takeoff-preview-viewport"
      className="absolute inset-0"
      aria-label="3D takeoff preview viewport"
    />
  )
}

function buildItemObjects(item: TakeoffPreviewItem, selected: boolean): THREE.Object3D[] {
  if (item.kind === 'polygon') return buildPolygonObjects(item, selected)
  if (item.kind === 'lineal') return buildLinealObjects(item, selected)
  if (item.kind === 'count') return buildCountObjects(item, selected)
  if (item.kind === 'volume') return buildVolumeObjects(item, selected)
  return []
}

function buildPolygonObjects(item: TakeoffPreviewItem, selected: boolean): THREE.Object3D[] {
  const shape = new THREE.Shape()
  const [first, ...rest] = item.points
  if (!first) return []
  shape.moveTo(first.x, -first.z)
  for (const point of rest) shape.lineTo(point.x, -point.z)
  shape.closePath()

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.15, item.heightFt),
    bevelEnabled: false,
  })
  geometry.rotateX(-Math.PI / 2)
  geometry.computeVertexNormals()

  const material = new THREE.MeshStandardMaterial({
    color: item.color,
    roughness: 0.65,
    metalness: 0.05,
    transparent: true,
    opacity: selected ? 0.94 : 0.76,
    emissive: selected ? new THREE.Color(0x2d1b0b) : new THREE.Color(0x000000),
  })
  const mesh = new THREE.Mesh(geometry, material)

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: selected ? 0xffffff : 0x1f2933, linewidth: 1 }),
  )
  return [mesh, edges]
}

function buildLinealObjects(item: TakeoffPreviewItem, selected: boolean): THREE.Object3D[] {
  const objects: THREE.Object3D[] = []
  for (let index = 1; index < item.points.length; index += 1) {
    const start = item.points[index - 1]
    const end = item.points[index]
    if (!start || !end) continue
    objects.push(cylinderBetween(start, end, selected ? 0.28 : 0.2, item.color, selected))
  }
  return objects
}

function buildCountObjects(item: TakeoffPreviewItem, selected: boolean): THREE.Object3D[] {
  return item.points.map((point) => {
    const geometry = new THREE.CylinderGeometry(selected ? 0.75 : 0.55, selected ? 0.75 : 0.55, item.heightFt, 20)
    const material = new THREE.MeshStandardMaterial({ color: item.color, roughness: 0.55 })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(point.x, item.heightFt / 2, point.z)
    return mesh
  })
}

function buildVolumeObjects(item: TakeoffPreviewItem, selected: boolean): THREE.Object3D[] {
  const point = item.points[0]
  if (!point) return []
  const depth = item.depthFt ?? 3
  const width = item.widthFt ?? 3
  const height = item.heightFt
  const geometry = new THREE.BoxGeometry(depth, height, width)
  const material = new THREE.MeshStandardMaterial({
    color: item.color,
    roughness: 0.62,
    transparent: true,
    opacity: selected ? 0.9 : 0.72,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(point.x, height / 2, point.z)
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0xffffff }),
  )
  edges.position.copy(mesh.position)
  return [mesh, edges]
}

function cylinderBetween(
  start: TakeoffPreviewPoint,
  end: TakeoffPreviewPoint,
  radius: number,
  color: string,
  selected: boolean,
): THREE.Mesh {
  const a = new THREE.Vector3(start.x, Math.max(0.2, radius), start.z)
  const b = new THREE.Vector3(end.x, Math.max(0.2, radius), end.z)
  const direction = b.clone().sub(a)
  const length = direction.length()
  const geometry = new THREE.CylinderGeometry(radius, radius, Math.max(0.01, length), selected ? 18 : 12)
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.5 })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.copy(a.clone().add(b).multiplyScalar(0.5))
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
  return mesh
}

function sceneSpan(scene: TakeoffPreviewScene): number {
  const width = scene.bounds.maxX - scene.bounds.minX
  const depth = scene.bounds.maxZ - scene.bounds.minZ
  return Math.max(width, depth, 40)
}

function findMeasurementId(object: THREE.Object3D | undefined): string | null {
  let current: THREE.Object3D | null | undefined = object
  while (current) {
    const id = current.userData.measurementId
    if (typeof id === 'string') return id
    current = current.parent
  }
  return null
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const material = mesh.material
    if (Array.isArray(material)) {
      for (const entry of material) entry.dispose()
    } else if (material) {
      material.dispose()
    }
  })
}
