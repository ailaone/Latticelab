import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { LatticeGenerator } from './utils/latticeGeometry.js';
import { exportToOBJ } from './utils/exportOBJ.js';

// --- Scene Setup ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x242424);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(150, 150, 150);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Limit pixel ratio for performance
document.querySelector('#app').appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// --- Lighting ---
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1);
dirLight.position.set(50, 100, 50);
scene.add(dirLight);

// --- State ---
const params = {
    type: 'cubic',
    width: 100,
    height: 100,
    depth: 100,
    cellSize: 20,
    wallThickness: 2,
    materialColor: '#8a9097',
    wireframe: false,

    // Advanced
    variableDensity: false,
    densityAxis: 'Y',
    densityMin: 0.2, // Multiplier for wallThickness
    densityMax: 1.0,
    jitter: 0, // Random node displacement ratio relative to cellSize
    gooey: false,
    resolution: 60,

    // Appearance
    preset: 'Custom',

    // Tools
    copyConfig: () => copyConfiguration(),
    loadConfig: () => loadConfiguration(),

    // Stats (Read-only for GUI)
    strutCount: 0,
    volume: '0',

    export: () => exportToOBJ(scene, params)
};

const presets = {
    'Custom': { color: '#8a9097', roughness: 0.3, metalness: 0.5 },
    'Titanium': { color: '#b6b6b6', roughness: 0.4, metalness: 0.9 },
    'Nylon': { color: '#f5f5f5', roughness: 0.8, metalness: 0.0 },
    'Resin': { color: '#2b9348', roughness: 0.2, metalness: 0.1 },
    'Gold': { color: '#FFD700', roughness: 0.2, metalness: 1.0 }
};

function copyConfiguration() {
    const config = JSON.stringify(params, (key, val) => {
        if (typeof val === 'function' || key === 'strutCount' || key === 'volume') return undefined;
        return val;
    }, 2);
    navigator.clipboard.writeText(config).then(() => alert('Configuration copied to clipboard!'));
}

function loadConfiguration() {
    const input = prompt('Paste configuration JSON:');
    if (!input) return;
    try {
        const config = JSON.parse(input);
        Object.assign(params, config);
        // Refresh GUI
        gui.controllersRecursive().forEach(c => c.updateDisplay());
        // Update Material
        material.color.set(params.materialColor);
        material.roughness = material.roughness;
        if (params.preset && presets[params.preset]) {
            material.metalness = presets[params.preset].metalness;
        }
        generate();
    } catch (e) {
        alert('Invalid JSON');
    }
}

let latticeMesh = null;
const material = new THREE.MeshStandardMaterial({
    color: params.materialColor,
    roughness: 0.3,
    metalness: 0.5
});

// --- Generation ---
function generate() {
    if (latticeMesh) {
        scene.remove(latticeMesh);
        latticeMesh.geometry.dispose();
    }

    const geometry = LatticeGenerator.generate(params);

    latticeMesh = new THREE.Mesh(geometry, material);
    scene.add(latticeMesh);

    // Update stats
    if (geometry.userData) {
        params.strutCount = geometry.userData.strutCount || 0;
        const v = geometry.userData.volume;
        params.volume = (typeof v === 'number') ? (v / 1000).toFixed(2) + ' cm³' : v;
    }

    // Check if printing warning needed
    if (params.wallThickness < 0.6) {
        // Could show toast, but console for now
        console.warn("Wall thickness < 0.6mm might be too thin for printing.");
    }
}

// --- GUI ---
const gui = new GUI({ title: 'LatticeLab' });

const typeFolder = gui.addFolder('Lattice Type');
typeFolder.add(params, 'type', ['cubic', 'octet', 'bcc', 'diamond', 'kelvin']).name('Type').onChange(generate);


const dimFolder = gui.addFolder('Dimensions');
dimFolder.add(params, 'width', 10, 200).name('Width (mm)').onChange(generate);
dimFolder.add(params, 'height', 10, 200).name('Height (mm)').onChange(generate);
dimFolder.add(params, 'depth', 10, 200).name('Depth (mm)').onChange(generate);

const cellFolder = gui.addFolder('Cell Properties');
cellFolder.add(params, 'cellSize', 5, 50).name('Cell Size (mm)').onChange(generate);
cellFolder.add(params, 'wallThickness', 0.5, 5).name('Wall Thickness (mm)').onChange(generate);

const advFolder = gui.addFolder('Advanced Geometry');
advFolder.add(params, 'variableDensity').name('Variable Density').onChange(updateDensityVisibility);
advFolder.add(params, 'densityAxis', ['X', 'Y', 'Z']).name('Gradient Axis').onChange(generate);
advFolder.add(params, 'densityMin', 0.1, 2.0).name('Min Density Factor').onChange(generate);
advFolder.add(params, 'densityMax', 0.1, 2.0).name('Max Density Factor').onChange(generate);
advFolder.add(params, 'jitter', 0, 0.5).name('Jitter (0-0.5)').onChange(generate);
advFolder.add(params, 'gooey').name('Gooey Mode (Slow)').onChange(updateGooeyVisibility);
advFolder.add(params, 'resolution', 20, 150, 1).name('Resolution').onChange(generate);

function updateGooeyVisibility() {
    // Show/Hide resolution based on gooey mode
    // Note: lil-gui doesn't simplify hiding well without references.
    // simpler to just regen.
    generate();
}

function updateDensityVisibility() {
    generate();
}
const sceneFolder = gui.addFolder('Appearance');
sceneFolder.add(params, 'preset', Object.keys(presets)).name('Material Preset').onChange(name => {
    const p = presets[name];
    if (p) {
        params.materialColor = p.color;
        material.color.set(p.color);
        material.roughness = p.roughness;
        material.metalness = p.metalness;
        // Update controllers
        gui.controllersRecursive().forEach(c => c.updateDisplay());
    }
});
sceneFolder.addColor(params, 'materialColor').name('Color').onChange(c => material.color.set(c));
sceneFolder.add(params, 'wireframe').name('Wireframe').onChange(w => material.wireframe = w);

const statsFolder = gui.addFolder('Fabrication Stats');
statsFolder.add(params, 'strutCount').name('Elements').listen().disable();
statsFolder.add(params, 'volume').name('Est. Volume').listen().disable();

const toolsFolder = gui.addFolder('Tools');
toolsFolder.add(params, 'copyConfig').name('Copy Config');
toolsFolder.add(params, 'loadConfig').name('Load Config');
toolsFolder.add(params, 'export').name('Download OBJ');

// Initial generation
generate();

// --- Loop ---
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
});
