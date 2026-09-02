/* The town-square look: two-tone translucent spheres with a mask
   texture, name labels, a flat grid floor. Ported from the old
   panaudia.com square-elements.js; geometry is in centimetres. */

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

let skins = {};

function skinTexture(team) {
    const existing = skins[team];
    if (existing !== undefined) {
        return existing;
    } else {
        const texture = new THREE.TextureLoader().load("./images/mask.png");
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.repeat.set(1, 1);
        skins[team] = texture;
        return texture;
    }
}

const DEFAULT_INNER = 0x2f56ee;
const DEFAULT_OUTER = 0x00bbff;

// The sphere is built once with the default look; styleNode below
// recolours it in place as the entity's attrs and name arrive.
export function makeNode() {

    const geometry = new THREE.SphereGeometry(50, 32, 16);
    const skin = skinTexture("mask");
    const material = new THREE.MeshStandardMaterial({color: DEFAULT_OUTER, transparent: true, opacity: 0.4, map: skin, side: THREE.DoubleSide});
    const sphere = new THREE.Mesh(geometry, material);

    const geometry2 = new THREE.SphereGeometry(45, 32, 16);
    const material2 = new THREE.MeshStandardMaterial({color: DEFAULT_INNER, transparent: true, opacity: 0.2});
    const sphere2 = new THREE.Mesh(geometry2, material2);
    sphere2.renderOrder = -1;

    sphere.castShadow = false;
    sphere.rotation.y = Math.PI / 2;

    const group = new THREE.Group();
    group.add(sphere);
    group.add(sphere2);

    const label = addLabel(group, '');

    return {obj: group, outerMat: material, mat: material2, label};
}

// Attrs are the entity's base-profile attributes (strings); visitors
// from the 2D demo page have none and keep the default colours.
export function styleNode(node, name, attrs) {
    let inner = DEFAULT_INNER;
    let outer = DEFAULT_OUTER;
    if (attrs !== undefined && typeof attrs['inner-colour'] === 'string') {
        inner = parseInt(attrs['inner-colour'], 16);
        outer = typeof attrs['outer-colour'] === 'string' ? parseInt(attrs['outer-colour'], 16) : inner;
    }
    node.mat.color.setHex(inner);
    node.outerMat.color.setHex(outer);
    node.label.element.textContent = name ?? '';
}

const OUTER_OPACITY = 0.4;
const GHOST_OUTER_OPACITY = 0.08;
export const GHOST_INNER_OPACITY = 0.04;

// A ghosted (personally muted) sphere stays where it is but goes
// faint; world.js stops driving its inner opacity from loudness.
export function ghostNode(node, ghosted) {
    node.ghosted = ghosted;
    node.outerMat.opacity = ghosted ? GHOST_OUTER_OPACITY : OUTER_OPACITY;
    if (ghosted) { node.mat.opacity = GHOST_INNER_OPACITY; }
    node.label.element.classList.toggle('ghost', ghosted);
}

export function nodeDistance(node, distance) {
    node.label.visible = distance <= 1000;
}

function addLabel(node, name) {
    const labelDiv = document.createElement('div');
    labelDiv.className = 'nameLabel';
    labelDiv.textContent = name ?? '';

    const label = new CSS2DObject(labelDiv);
    label.position.set(0, 80, 0);
    label.center.set(0.5, 0.5);
    node.add(label);
    label.layers.set(0);
    label.visible = false;
    return label;
}

// Spawn near the centre regardless of cube size, so a newcomer is
// within clear earshot of whoever is already here.
export function adjustPosition(position) {
    position.x = getRandomInt(-800, 800);
    position.z = getRandomInt(-800, 800);
    return false;
}

function getRandomInt(min, max) {
    const minCeiled = Math.ceil(min);
    const maxFloored = Math.floor(max);
    return Math.floor(Math.random() * (maxFloored - minCeiled) + minCeiled);
}

export function addMapCamera(scene, cube_cm, camera) {
    const mapCamera = new THREE.OrthographicCamera(
        -(cube_cm / 2),         // Left
        (cube_cm / 2) + 1,      // Right
        (cube_cm / 2) + 1,      // Top
        -(cube_cm / 2),         // Bottom
        -5000,                  // Near
        1000);                  // Far

    mapCamera.up = new THREE.Vector3(0, 0, -1);
    mapCamera.lookAt(new THREE.Vector3(0, -1, 0));
    scene.add(mapCamera);
    return mapCamera;
}

// meSpheres collects the meshes so world.js can remove them on leave.
export function addMe(attr, camera, meSpheres) {

    const inner_colour = parseInt(attr.innerColour, 16);
    const outer_colour = parseInt(attr.outerColour, 16);

    const geometry = new THREE.SphereGeometry(cursorSize, 32, 16);
    const material = new THREE.MeshStandardMaterial({color: inner_colour});
    const sphere = new THREE.Mesh(geometry, material);
    sphere.castShadow = false;
    sphere.receiveShadow = false;
    const geometry2 = new THREE.SphereGeometry(cursorSize * 2, 32, 16);
    const material2 = new THREE.MeshStandardMaterial({color: outer_colour, transparent: true, opacity: 0.4});
    const sphere2 = new THREE.Mesh(geometry2, material2);
    sphere2.castShadow = false;
    sphere2.receiveShadow = false;

    camera.add(sphere);
    camera.add(sphere2);
    meSpheres.push(sphere, sphere2);
}

export function animateMapCamera(camera, mapCamera) {

}

export function clipMapCamera(renderer, mini_border, w, h, size) {
    var border = 20.0;
    renderer.setScissor(w - size - border, h - size - border, size, size);
    renderer.setViewport(w - size - border, h - size - border, size, size);
}

export function addLandscape(scene) {

}

export function addLights(scene, background) {
    scene.add(new THREE.AmbientLight(background, 3));
}

export function adjustCamera(camera) {

}

export const defaultMapSize = 260;
export const backgroundColour = 0xf4f4f4;

// 60 metres across, matching the simple demo page's SVG view so the
// two pages share the same audible and visible extent of `main`.
export const cubeSize = 60;

export const doShadows = true;
export const doFog = true;

export const showMinorGrid = false;
export const floorShadow = false;
export const football = false;
export const useLabels = true;

export const cursorSize = 80;

export const distance = 6000;
export const fogDistance = 5000;
