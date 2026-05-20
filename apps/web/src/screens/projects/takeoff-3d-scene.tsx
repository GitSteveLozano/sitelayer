import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { TakeoffPreviewItem, TakeoffPreviewPoint, TakeoffPreviewScene } from '@/lib/takeoff/geometry-3d'

interface TakeoffThreeSceneProps {
  scene: TakeoffPreviewScene
  selectedId: string | null
  onSelect: (id: string | null) => void
  blueprintTextureUrl?: string | null
}

export function TakeoffThreeScene({ scene, selectedId, onSelect, blueprintTextureUrl }: TakeoffThreeSceneProps) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const onSelectRef = useRef(onSelect)
  const selectedIdRef = useRef(selectedId)
  const selectionStateRef = useRef<{ root: THREE.Group; render: () => void } | null>(null)

  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  useEffect(() => {
    selectedIdRef.current = selectedId
    const state = selectionStateRef.current
    if (!state) return
    applyMeasurementSelection(state.root, selectedId)
    state.render()
  }, [selectedId])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    let disposed = false
    const ownedTextures: THREE.Texture[] = []

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
    const render = () => renderer.render(threeScene, camera)

    const gridSize = Math.max(80, span * 1.35)
    if (blueprintTextureUrl) {
      const loader = new THREE.TextureLoader()
      loader.load(
        blueprintTextureUrl,
        (texture) => {
          if (disposed) {
            texture.dispose()
            return
          }
          texture.colorSpace = THREE.SRGBColorSpace
          texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy())
          ownedTextures.push(texture)
          root.add(buildBlueprintPlane(scene, texture))
          render()
        },
        undefined,
        () => {
          // The adjacent source-status copy tells the user when an image
          // underlay did not load; keep the WebGL scene alive.
        },
      )
    }
    const grid = new THREE.GridHelper(gridSize, 20, 0x3b4350, 0x242b36)
    root.add(grid)

    const ambient = new THREE.HemisphereLight(0xffffff, 0x18202b, 1.8)
    threeScene.add(ambient)
    const key = new THREE.DirectionalLight(0xffffff, 2.5)
    key.position.set(40, 80, 30)
    threeScene.add(key)

    const clickable: THREE.Object3D[] = []
    for (const item of scene.items) {
      const objects = buildItemObjects(item, false, scene)
      for (const object of objects) {
        object.userData.measurementId = item.id
        rememberMeasurementMaterialDefaults(object)
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
    selectionStateRef.current = { root, render }
    applyMeasurementSelection(root, selectedIdRef.current)
    resize()
    render()

    return () => {
      disposed = true
      if (selectionStateRef.current?.root === root) selectionStateRef.current = null
      observer.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      renderer.domElement.removeEventListener('wheel', onWheel)
      mount.removeChild(renderer.domElement)
      disposeObject(root)
      for (const texture of ownedTextures) texture.dispose()
      grid.geometry.dispose()
      renderer.dispose()
    }
  }, [scene, blueprintTextureUrl])

  return (
    <div
      ref={mountRef}
      data-testid="takeoff-preview-viewport"
      className="absolute inset-0"
      aria-label="3D takeoff preview viewport"
    />
  )
}

function buildBlueprintPlane(scene: TakeoffPreviewScene, texture: THREE.Texture): THREE.Object3D {
  const group = new THREE.Group()
  const boardSize = Math.max(24, 100 * scene.worldPerBoardUnit)
  const geometry = new THREE.PlaneGeometry(boardSize, boardSize)
  geometry.rotateX(-Math.PI / 2)

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  })
  const plane = new THREE.Mesh(geometry, material)
  plane.position.y = -0.04
  plane.renderOrder = -2
  group.add(plane)

  const borderGeometry = new THREE.EdgesGeometry(geometry)
  const border = new THREE.LineSegments(borderGeometry, new THREE.LineBasicMaterial({ color: 0x9fb3c8 }))
  border.position.y = -0.035
  border.renderOrder = -1
  group.add(border)
  return group
}

function buildItemObjects(item: TakeoffPreviewItem, selected: boolean, scene: TakeoffPreviewScene): THREE.Object3D[] {
  if (item.kind === 'polygon') return buildPolygonObjects(item, selected)
  if (item.kind === 'lineal') return buildLinealObjects(item, selected)
  if (item.kind === 'count') return buildCountObjects(item, selected, scene)
  if (item.kind === 'volume') return buildVolumeObjects(item, selected)
  return []
}

function rememberMeasurementMaterialDefaults(object: THREE.Object3D): void {
  object.traverse((child) => {
    const material = (child as THREE.Mesh).material
    for (const entry of Array.isArray(material) ? material : material ? [material] : []) {
      if (entry.userData.selectionBase) continue
      entry.userData.selectionBase = {
        opacity: entry.opacity,
        transparent: entry.transparent,
        color: materialColor(entry)?.getHex() ?? null,
        emissive: entry instanceof THREE.MeshStandardMaterial ? entry.emissive.getHex() : null,
      }
    }
  })
}

function applyMeasurementSelection(root: THREE.Object3D, selectedId: string | null): void {
  root.traverse((child) => {
    const measurementId = findMeasurementId(child)
    if (!measurementId) return
    const selected = selectedId === measurementId
    const material = (child as THREE.Mesh).material
    for (const entry of Array.isArray(material) ? material : material ? [material] : []) {
      applyMaterialSelection(entry, selected)
    }
  })
}

function applyMaterialSelection(material: THREE.Material, selected: boolean): void {
  const base = material.userData.selectionBase as
    | { opacity: number; transparent: boolean; color: number | null; emissive: number | null }
    | undefined
  if (!base) return

  material.opacity = selected ? Math.min(1, base.opacity + 0.2) : base.opacity
  material.transparent = base.transparent || material.opacity < 1
  material.needsUpdate = true

  const color = materialColor(material)
  if (color && base.color != null) {
    color.setHex(selected ? 0xffffff : base.color)
  }
  if (material instanceof THREE.MeshStandardMaterial && base.emissive != null) {
    material.emissive.setHex(selected ? 0x1f2a44 : base.emissive)
  }
}

function materialColor(material: THREE.Material): THREE.Color | null {
  const candidate = (material as THREE.Material & { color?: unknown }).color
  return candidate instanceof THREE.Color ? candidate : null
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
    objects.push(...wallBetween(start, end, selected ? 0.42 : 0.3, item.heightFt, item.color, selected))
  }
  return objects
}

function buildCountObjects(item: TakeoffPreviewItem, selected: boolean, scene: TakeoffPreviewScene): THREE.Object3D[] {
  const objects: THREE.Object3D[] = []
  for (const point of item.points) {
    const marker = countMarkerDimensions(item, selected)
    const geometry = new THREE.BoxGeometry(marker.width, marker.height, marker.depth)
    const isOpening = isOpeningCount(item)
    const material = new THREE.MeshStandardMaterial({
      color: item.color,
      roughness: 0.48,
      transparent: true,
      opacity: selected ? 0.86 : isOpening ? 0.48 : 0.82,
      wireframe: isOpening,
      emissive: selected ? new THREE.Color(0x101826) : new THREE.Color(0x000000),
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(point.x, marker.baseY + marker.height / 2, point.z)
    mesh.rotation.y = nearestLinealRotation(point, scene)

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: selected ? 0xffffff : 0xd7e8ff }),
    )
    edges.position.copy(mesh.position)
    edges.rotation.copy(mesh.rotation)
    objects.push(mesh, edges)
  }
  return objects
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

function wallBetween(
  start: TakeoffPreviewPoint,
  end: TakeoffPreviewPoint,
  thickness: number,
  height: number,
  color: string,
  selected: boolean,
): THREE.Object3D[] {
  const dx = end.x - start.x
  const dz = end.z - start.z
  const length = Math.hypot(dx, dz)
  if (!Number.isFinite(length) || length <= 0) return []

  const geometry = new THREE.BoxGeometry(length, Math.max(0.5, height), thickness)
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.58,
    transparent: true,
    opacity: selected ? 0.88 : 0.64,
    emissive: selected ? new THREE.Color(0x24170a) : new THREE.Color(0x000000),
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set((start.x + end.x) / 2, Math.max(0.5, height) / 2, (start.z + end.z) / 2)
  mesh.rotation.y = -Math.atan2(dz, dx)

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: selected ? 0xffffff : 0x1f2933 }),
  )
  edges.position.copy(mesh.position)
  edges.rotation.copy(mesh.rotation)
  return [mesh, edges]
}

function countMarkerDimensions(
  item: TakeoffPreviewItem,
  selected: boolean,
): { width: number; height: number; depth: number; baseY: number } {
  if (item.serviceItemCode.startsWith('08 14')) {
    return {
      width: selected ? 1.35 : 1.05,
      height: Math.max(6.5, item.heightFt),
      depth: selected ? 0.34 : 0.24,
      baseY: 0.05,
    }
  }
  if (item.serviceItemCode.startsWith('08 50')) {
    return {
      width: selected ? 1.45 : 1.15,
      height: Math.max(3, item.heightFt),
      depth: selected ? 0.32 : 0.22,
      baseY: 3,
    }
  }
  return {
    width: selected ? 1 : 0.72,
    height: Math.max(0.8, item.heightFt),
    depth: selected ? 1 : 0.72,
    baseY: 0.2,
  }
}

function isOpeningCount(item: TakeoffPreviewItem): boolean {
  return item.serviceItemCode.startsWith('08 14') || item.serviceItemCode.startsWith('08 50')
}

function nearestLinealRotation(point: TakeoffPreviewPoint, scene: TakeoffPreviewScene): number {
  let bestDistance = Number.POSITIVE_INFINITY
  let bestRotation = 0

  for (const item of scene.items) {
    if (item.kind !== 'lineal') continue
    for (let index = 1; index < item.points.length; index += 1) {
      const start = item.points[index - 1]
      const end = item.points[index]
      if (!start || !end) continue
      const distance = pointToSegmentDistanceSq(point, start, end)
      if (distance < bestDistance) {
        bestDistance = distance
        bestRotation = -Math.atan2(end.z - start.z, end.x - start.x)
      }
    }
  }

  return bestRotation
}

function pointToSegmentDistanceSq(
  point: TakeoffPreviewPoint,
  start: TakeoffPreviewPoint,
  end: TakeoffPreviewPoint,
): number {
  const dx = end.x - start.x
  const dz = end.z - start.z
  const lengthSq = dx * dx + dz * dz
  if (lengthSq <= 0) return (point.x - start.x) ** 2 + (point.z - start.z) ** 2
  const t = THREE.MathUtils.clamp(((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSq, 0, 1)
  const projectedX = start.x + t * dx
  const projectedZ = start.z + t * dz
  return (point.x - projectedX) ** 2 + (point.z - projectedZ) ** 2
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
