// 3D グラフ描画用ライブラリを 1 ファイルにまとめるためのエントリ(public/vendor/graph3d.bundle.js を生成)
import ForceGraph3D from '3d-force-graph';
import {
  Group, Mesh, SphereGeometry, MeshLambertMaterial, MeshBasicMaterial, Sprite, SpriteMaterial,
  TextureLoader, Color, DoubleSide, SRGBColorSpace,
  Points, PointsMaterial, BufferGeometry, Float32BufferAttribute, IcosahedronGeometry, EdgesGeometry,
  LineSegments, LineBasicMaterial, LineLoop, RingGeometry, TorusGeometry, CanvasTexture, AdditiveBlending,
  Vector2, Vector3, Fog,
} from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import SpriteText from 'three-spritetext';
import { forceCollide } from 'd3-force-3d';

window.ForceGraph3D = ForceGraph3D;
window.SpriteText = SpriteText;
window.d3f = { forceCollide };
window.THREE = {
  Group, Mesh, SphereGeometry, MeshLambertMaterial, MeshBasicMaterial, Sprite, SpriteMaterial,
  TextureLoader, Color, DoubleSide, SRGBColorSpace,
  Points, PointsMaterial, BufferGeometry, Float32BufferAttribute, IcosahedronGeometry, EdgesGeometry,
  LineSegments, LineBasicMaterial, LineLoop, RingGeometry, TorusGeometry, CanvasTexture, AdditiveBlending,
  Vector2, Vector3, Fog, UnrealBloomPass,
};
