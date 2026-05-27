import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import type { ScaffoldScene } from '@/lib/scaffold/scaffold-scene'

/**
 * Lightweight three.js renderer for a scaffold model. Structural members are
 * drawn as colored line segments; decks as translucent planes. Drag to rotate,
 * scroll to zoom. Reuses the takeoff preview's WebGL lifecycle patterns.
 */
export function ScaffoldThreeScene({ scene }: { scene: ScaffoldScene }) {
  const mountRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(0x0d1117, 1)
    renderer.domElement.dataset.testid = 'scaffold-canvas'
    mount.appendChild(renderer.domElement)

    const threeScene = new THREE.Scene()
    threeScene.background = new THREE.Color(0x0d1117)

    const span = Math.max(scene.spanFt, scene.heightFt, 8)
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000)
    camera.position.set(span * 0.9, Math.max(span * 0.7, scene.heightFt * 1.1), span * 1.15)
    camera.lookAt(0, scene.heightFt / 2, 0)

    const root = new THREE.Group()
    threeScene.add(root)
    const render = () => renderer.render(threeScene, camera)

    root.add(new THREE.GridHelper(Math.max(40, span * 2), 24, 0x3b4350, 0x242b36))
    threeScene.add(new THREE.HemisphereLight(0xffffff, 0x18202b, 1.9))
    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(span, span * 1.5, span)
    threeScene.add(key)

    // Structural members → one LineSegments with per-vertex colors.
    const linePositions: number[] = []
    const lineColors: number[] = []
    const color = new THREE.Color()
    for (const seg of scene.segments) {
      if (seg.role === 'deck' || seg.role === 'base_plate') continue
      color.set(seg.color)
      linePositions.push(seg.a.x, seg.a.y, seg.a.z, seg.b.x, seg.b.y, seg.b.z)
      lineColors.push(color.r, color.g, color.b, color.r, color.g, color.b)
    }
    const lineGeom = new THREE.BufferGeometry()
    lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3))
    lineGeom.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3))
    const lines = new THREE.LineSegments(lineGeom, new THREE.LineBasicMaterial({ vertexColors: true }))
    root.add(lines)

    // Decks → translucent planes spanning each bay at their lift height.
    const deckMaterial = new THREE.MeshStandardMaterial({
      color: 0x8e735b,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
    })
    for (const seg of scene.segments) {
      if (seg.role !== 'deck') continue
      const w = Math.abs(seg.b.x - seg.a.x) || 0.1
      const d = Math.abs(seg.b.z - seg.a.z) || 0.1
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, d), deckMaterial)
      plane.rotation.x = -Math.PI / 2
      plane.position.set((seg.a.x + seg.b.x) / 2, seg.a.y, (seg.a.z + seg.b.z) / 2)
      root.add(plane)
    }

    const drag = { active: false, x: 0, y: 0 }
    const resize = () => {
      const rect = mount.getBoundingClientRect()
      const width = Math.max(1, rect.width)
      const height = Math.max(1, rect.height)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      render()
    }
    const onDown = (e: PointerEvent) => {
      drag.active = true
      drag.x = e.clientX
      drag.y = e.clientY
      renderer.domElement.setPointerCapture(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      if (!drag.active) return
      root.rotation.y += (e.clientX - drag.x) * 0.008
      root.rotation.x = THREE.MathUtils.clamp(root.rotation.x + (e.clientY - drag.y) * 0.006, -0.7, 0.6)
      drag.x = e.clientX
      drag.y = e.clientY
      render()
    }
    const onUp = (e: PointerEvent) => {
      drag.active = false
      try {
        renderer.domElement.releasePointerCapture(e.pointerId)
      } catch {
        // ignore release races during unmount
      }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      camera.position.multiplyScalar(e.deltaY > 0 ? 1.08 : 0.92)
      const dist = camera.position.length()
      if (dist < 6) camera.position.setLength(6)
      if (dist > 600) camera.position.setLength(600)
      camera.lookAt(0, scene.heightFt / 2, 0)
      render()
    }

    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointermove', onMove)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false })
    const observer = new ResizeObserver(resize)
    observer.observe(mount)
    resize()
    render()

    return () => {
      observer.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('wheel', onWheel)
      mount.removeChild(renderer.domElement)
      lineGeom.dispose()
      lines.material.dispose()
      deckMaterial.dispose()
      root.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.dispose()
      })
      renderer.dispose()
    }
  }, [scene])

  return (
    <div
      ref={mountRef}
      data-testid="scaffold-viewport"
      className="absolute inset-0"
      aria-label="Scaffold 3D viewport"
    />
  )
}
