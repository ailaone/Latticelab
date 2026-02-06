import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';

export function exportToOBJ(scene, latticeParams) {
    const exporter = new OBJExporter();
    // We only want to export the Mesh objects that are part of the lattice
    // Simplification: Assume the lattice is in a specific Group or we filter scene.children

    // For now, let's assume we pass the specific mesh or group to export
    const result = exporter.parse(scene);

    const date = new Date().toISOString().split('T')[0];
    const filename = `lattice_${latticeParams.type}_${latticeParams.cellSize}mm_${date}.obj`;

    saveString(result, filename);
}

function saveString(text, filename) {
    const blob = new Blob([text], { type: 'text/plain' });
    const link = document.createElement('a');
    link.style.display = 'none';
    document.body.appendChild(link);
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    document.body.removeChild(link);
}
