import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MarchingCubes } from 'three/examples/jsm/objects/MarchingCubes.js';


export class LatticeGenerator {
    static generate(params) {
        if (params.gooey) {
            return this.generateImplicitLattice(params);
        }

        switch (params.type) {
            case 'cubic': return this.generateCubic(params);
            case 'octet': return this.generateOctet(params);
            case 'bcc': return this.generateBCC(params);
            case 'diamond': return this.generateDiamond(params);
            case 'kelvin': return this.generateKelvin(params);

            default: return new THREE.BufferGeometry();
        }
    }


    static generateImplicitLattice(params) {
        console.time('GooeyGen');
        const segments = [];
        const originalCreateStrut = this.createStrut;

        // 1. Harvest Segments
        try {
            // Override createStrut to collect data instead of building geometry
            this.createStrut = (vStart, vEnd, radius) => {
                segments.push({ start: vStart.clone(), end: vEnd.clone(), radius });
                return new THREE.BufferGeometry();
            };

            // Trigger generation with gooey=false to avoid recursion
            const tempParams = { ...params, gooey: false };
            this.generate(tempParams);

        } finally {
            this.createStrut = originalCreateStrut;
        }

        console.log(`Gooey: Harvested ${segments.length} segments.`);

        // 2. Setup Marching Cubes
        const resolution = params.resolution || 60;
        const mc = new MarchingCubes(resolution, new THREE.MeshBasicMaterial(), false, false);

        const f = mc.field;
        f.fill(0);

        const size = Math.max(params.width, params.height, params.depth);
        const halfSize = size / 2;

        const worldToGrid = (v) => {
            const x = Math.floor((v.x + halfSize) / size * resolution);
            const y = Math.floor((v.y + halfSize) / size * resolution);
            const z = Math.floor((v.z + halfSize) / size * resolution);
            return { x, y, z };
        };

        console.time('Rasterize');
        const p = new THREE.Vector3();
        const ab = new THREE.Vector3();
        const ap = new THREE.Vector3();

        for (const seg of segments) {
            const padding = seg.radius * 2.5;
            const min = new THREE.Vector3().copy(seg.start).min(seg.end).subScalar(padding);
            const max = new THREE.Vector3().copy(seg.start).max(seg.end).addScalar(padding);

            const gMin = worldToGrid(min);
            const gMax = worldToGrid(max);

            gMin.x = Math.max(0, gMin.x); gMin.y = Math.max(0, gMin.y); gMin.z = Math.max(0, gMin.z);
            gMax.x = Math.min(resolution - 1, gMax.x); gMax.y = Math.min(resolution - 1, gMax.y); gMax.z = Math.min(resolution - 1, gMax.z);

            ab.subVectors(seg.end, seg.start);
            const abLenSq = ab.lengthSq();
            const rSq = seg.radius * seg.radius;

            for (let k = gMin.z; k <= gMax.z; k++) {
                const wz = (k / resolution - 0.5) * size;
                for (let j = gMin.y; j <= gMax.y; j++) {
                    const wy = (j / resolution - 0.5) * size;
                    for (let i = gMin.x; i <= gMax.x; i++) {
                        const wx = (i / resolution - 0.5) * size;

                        p.set(wx, wy, wz);
                        ap.subVectors(p, seg.start);

                        let t = ap.dot(ab);
                        if (abLenSq > 0) t /= abLenSq;
                        t = Math.max(0, Math.min(1, t));

                        const cx = ap.x - t * ab.x;
                        const cy = ap.y - t * ab.y;
                        const cz = ap.z - t * ab.z;
                        const distSq = cx * cx + cy * cy + cz * cz;

                        // Metaball falloff 
                        const val = rSq / (distSq + 0.0001);
                        f[i + j * resolution + k * resolution * resolution] += val;
                    }
                }
            }
        }
        console.timeEnd('Rasterize');

        // 3. Generate Geometry
        mc.isolation = 1.0;
        mc.update();

        if (!mc.geometry) return new THREE.BufferGeometry();

        const geo = mc.geometry.clone();

        // Adaptive Scaling (Robust to MC implementation)
        geo.computeBoundingBox();
        const box = geo.boundingBox;
        const center = new THREE.Vector3();
        box.getCenter(center);

        // 1. Center
        geo.translate(-center.x, -center.y, -center.z);

        // 2. Scale to fit Size
        const rawSizeX = box.max.x - box.min.x;
        const rawSizeY = box.max.y - box.min.y;
        const rawSizeZ = box.max.z - box.min.z;
        const rawMaxDim = Math.max(rawSizeX, rawSizeY, rawSizeZ);

        if (rawMaxDim > 0) {
            // Target size
            const targetSize = Math.max(params.width, params.height, params.depth);

            // If the raw mesh is tiny (e.g. -1..1 range), this scales it up.
            // If it's 0..resolution, this scales it correctly.
            const scale = targetSize / rawMaxDim;
            geo.scale(scale, scale, scale);

            console.log(`Gooey: Scaled by ${scale.toFixed(3)} (Raw: ${rawMaxDim.toFixed(2)} -> Target: ${targetSize})`);
        }

        geo.userData = {
            strutCount: segments.length,
            volume: 'N/A (Implicit)'
        };
        console.timeEnd('GooeyGen');
        return geo;
    }

    static getDensityFactor(params, x, y, z) {
        if (!params.variableDensity) return 1.0;

        let t = 0;
        const { width, height, depth, densityAxis, densityMin, densityMax } = params;

        // Normalize position to 0..1 range based on bounds
        switch (densityAxis) {
            case 'X': t = (x + width / 2) / width; break;
            case 'Y': t = (y + height / 2) / height; break;
            case 'Z': t = (z + depth / 2) / depth; break;
            default: t = 0.5; // Default to middle if axis not specified
        }

        // Clamp 0..1
        t = Math.max(0, Math.min(1, t));

        // Linear interpolation
        return densityMin + (densityMax - densityMin) * t;
    }

    static getJitteredPosition(ix, iy, iz, cellSize, jitter, params) {
        // Base position of the cell origin
        const px = ix * cellSize - params.width / 2;
        const py = iy * cellSize - params.height / 2;
        const pz = iz * cellSize - params.depth / 2;

        if (jitter === 0) return new THREE.Vector3(px, py, pz);

        // Pseudo-random hash for deterministic jitter based on grid indices
        // This hash function is a common way to get a repeatable pseudo-random number from integers.
        const hash = (x, y, z) => {
            let h = x * 73856093 ^ y * 19349663 ^ z * 83492791;
            h = Math.imul(h ^ h >>> 15, h | 1);
            h ^= h + Math.imul(h ^ h >>> 7, h | 61);
            return ((h ^ h >>> 14) >>> 0) / 4294967296; // Normalize to [0, 1]
        };

        const jMag = cellSize * jitter;
        const jx = (hash(ix, iy, iz) - 0.5) * jMag;
        const jy = (hash(ix, iy, iz + 1) - 0.5) * jMag; // Use different seed for y
        const jz = (hash(ix, iy + 1, iz) - 0.5) * jMag; // Use different seed for z

        return new THREE.Vector3(px + jx, py + jy, pz + jz);
    }

    // Helper to get node for strut lattices (handles jitter)
    static getNode(ix, iy, iz, cellSize, params) {
        // This function should return the jittered position of a *specific* node,
        // not just the cell origin.
        // For strut lattices, nodes are typically at cell corners or specific fractions within a cell.
        // To ensure shared nodes jitter consistently, we need a unique identifier for each node.
        // A simple way is to use the absolute grid coordinates of the node.
        // For example, a node at (ix*cellSize, iy*cellSize, iz*cellSize) would use (ix, iy, iz) as its hash input.
        // A node at (ix*cellSize + cellSize/2, ...) would use (ix + 0.5, iy, iz) as its hash input.
        // This requires the cellFunction to pass the *normalized* node coordinates.

        // Let's simplify for now: `getNode` returns the jittered *cell origin*.
        // The `cellFunction` then adds its internal offsets.
        // This means internal nodes will jitter relative to the cell origin, but cell origins will be consistent.
        // This is a compromise. A more robust solution would be to have a global node registry with jitter.
        // For now, `getJitteredPosition` is used for the *cell origin*.
        // The `cellFunction` will then add its internal offsets to this jittered origin.
        // This means nodes *within* a cell will jitter together, but nodes *shared* between cells (e.g., corners)
        // will only jitter based on the cell they are "defined" in.
        // This is not ideal for shared nodes.

        // Let's redefine `getNode` to take world coordinates and apply jitter based on a grid.
        // This is still tricky. The instruction implies `getJitteredPosition(ix, iy, iz, ...)`
        // which suggests `ix, iy, iz` are integer cell indices.

        // Let's assume `getNode` is meant to provide a jittered *cell origin* for now.
        // The `cellFunction` will then add its internal offsets to this jittered origin.
        // This means shared nodes (like corners) will only be jittered by the cell they are generated from.
        // This is a known limitation for simple jitter implementations in strut lattices.
        // A proper solution would involve a global map of jittered node positions.

        // For the purpose of this instruction, `getJitteredPosition` is defined to return a jittered cell origin.
        // The `cellFunction` will then use this jittered origin.
        // The `generateDiamond` example shows `px, py, pz` as the cell origin.
        // So, `getNode` should return the jittered cell origin.
        return LatticeGenerator.getJitteredPosition(ix, iy, iz, cellSize, params.jitter || 0, params);
    }

    static getSpatialJitter(vector, cellSize, jitter) {
        if (!jitter) return vector;

        // Simple distinct spatial hash for floating point coords
        // Quantize slightly to avoid float precision issues? 
        // 0.001 mm precision is plenty.
        const q = 1000;
        const x = Math.round(vector.x * q);
        const y = Math.round(vector.y * q);
        const z = Math.round(vector.z * q);

        const hash = (a, b, c) => {
            let h = a * 73856093 ^ b * 19349663 ^ c * 83492791;
            h = Math.imul(h ^ h >>> 15, h | 1);
            h ^= h + Math.imul(h ^ h >>> 7, h | 61);
            return ((h ^ h >>> 14) >>> 0) / 4294967296;
        };

        const jMag = cellSize * jitter;
        const jx = (hash(x, y, z) - 0.5) * jMag;
        const jy = (hash(x, y + 101, z) - 0.5) * jMag;
        const jz = (hash(x, y, z + 202) - 0.5) * jMag;

        return new THREE.Vector3(vector.x + jx, vector.y + jy, vector.z + jz);
    }

    // ... getNode ...

    // ... generateOctet ...

    static generateOctet(params) {
        return this.generateStrutLattice(params, (x, y, z, cellSize, geometries, radius) => {
            // Octet nodes are at corners and face centers.
            // Map to 2x grid to index them with integers.
            // size of sub-grid cell is cellSize / 2.
            const s = cellSize / 2;

            // Helper to get jittered node from 2x grid index
            const getN = (ix, iy, iz) => this.getNode(ix, iy, iz, s, params);

            const ix = 2 * x;
            const iy = 2 * y;
            const iz = 2 * z;

            // Corners
            const p000 = getN(ix, iy, iz);
            const p100 = getN(ix + 2, iy, iz);
            const p010 = getN(ix, iy + 2, iz);
            const p001 = getN(ix, iy, iz + 2);
            const p110 = getN(ix + 2, iy + 2, iz);
            const p101 = getN(ix + 2, iy, iz + 2);
            const p011 = getN(ix, iy + 2, iz + 2);

            // Face Centers
            const f_xy = getN(ix + 1, iy + 1, iz);
            const f_yz = getN(ix, iy + 1, iz + 1);
            const f_xz = getN(ix + 1, iy, iz + 1);

            // Struts: 12 edges of the octahedron inside + edges of tetrahedrons?
            // Standard Octet construction:
            // 1. Face diagonals of the cube (12 diag).
            // This connects Corner <-> Face Center.
            // p000 connects to f_xy, f_xz, f_yz.

            // Let's implement the localized connections for this cell.
            // Connect internal Face Centers to corners of THIS cell?
            // Yes.

            // Face XY (z=0)
            geometries.push(this.createStrut(p000, f_xy, radius));
            geometries.push(this.createStrut(p100, f_xy, radius));
            geometries.push(this.createStrut(p010, f_xy, radius)); // wait, f_xy connects to p110 too?
            geometries.push(this.createStrut(p110, f_xy, radius));

            // Face YZ (x=0)
            geometries.push(this.createStrut(p000, f_yz, radius));
            geometries.push(this.createStrut(p010, f_yz, radius));
            geometries.push(this.createStrut(p011, f_yz, radius));
            geometries.push(this.createStrut(p001, f_yz, radius));

            // Face XZ (y=0)
            geometries.push(this.createStrut(p000, f_xz, radius));
            geometries.push(this.createStrut(p100, f_xz, radius));
            geometries.push(this.createStrut(p101, f_xz, radius));
            geometries.push(this.createStrut(p001, f_xz, radius));

            // Connectivity check:
            // Each face center connected to 4 corners of its face.
            // This forms the "Face Diagonals" visually.
            // e.g. on XY face, p000 -> f_xy -> p110 is the diagonal.
            // AND p100 -> f_xy -> p010 is the other diagonal.
            // This creates the "X" on the face.
            // Since we iterate through all cells, we cover the "min" faces (z=0, x=0, y=0 of this cell).
            // What about the "max" faces (z=1, x=1, y=1)?
            // The neighbor cell at z+1 will generate its z=0 face, which corresponds to our z=1 face.
            // So internal faces are covered.
            // Boundary faces (at x=nx etc) are NOT covered by neighbors later.
            // We need to generate max-face geometry if at boundary?
            // Yes, standard tiling problem.

            // Boundary checks:
            // If z == nz-1, generate Top Face (z=1)
            // Top Face Center: f_xy_top = getN(ix+1, iy+1, iz+2)
            // Connect to p001, p101, p011, p111?
            const { width, height, depth } = params;
            const nx = Math.floor(width / cellSize);
            const ny = Math.floor(height / cellSize);
            const nz = Math.floor(depth / cellSize);

            if (z === nz - 1) {
                const f_top = getN(ix + 1, iy + 1, iz + 2);
                const p001 = getN(ix, iy, iz + 2);
                const p101 = getN(ix + 2, iy, iz + 2);
                const p011 = getN(ix, iy + 2, iz + 2);
                const p111 = getN(ix + 2, iy + 2, iz + 2);

                geometries.push(this.createStrut(p001, f_top, radius));
                geometries.push(this.createStrut(p101, f_top, radius));
                geometries.push(this.createStrut(p011, f_top, radius));
                geometries.push(this.createStrut(p111, f_top, radius));
            }
            if (y === ny - 1) {
                const f_right = getN(ix + 1, iy + 2, iz + 1); // Y=1 face center
                const p010 = getN(ix, iy + 2, iz);
                const p110 = getN(ix + 2, iy + 2, iz);
                const p011 = getN(ix, iy + 2, iz + 2);
                // p111 defined above... wait, need to fetch if not defined
                const p111 = getN(ix + 2, iy + 2, iz + 2);

                geometries.push(this.createStrut(p010, f_right, radius));
                geometries.push(this.createStrut(p110, f_right, radius));
                geometries.push(this.createStrut(p011, f_right, radius));
                geometries.push(this.createStrut(p111, f_right, radius));
            }
            if (x === nx - 1) {
                const f_back = getN(ix + 2, iy + 1, iz + 1); // X=1 face center
                const p100 = getN(ix + 2, iy, iz);
                const p110 = getN(ix + 2, iy + 2, iz);
                const p101 = getN(ix + 2, iy, iz + 2);
                const p111 = getN(ix + 2, iy + 2, iz + 2);

                geometries.push(this.createStrut(p100, f_back, radius));
                geometries.push(this.createStrut(p110, f_back, radius));
                geometries.push(this.createStrut(p101, f_back, radius));
                geometries.push(this.createStrut(p111, f_back, radius));
            }
            // This covers the Faces.
            // Octet also has the Internal Octahedron edges?
            // The "Face Diagonals" form the Octahedron edges?
            // Wait. Octet truss is Tetrahedrons and Octahedrons.
            // The face diagonals of the cubes form the edges of the Octahedrons and Tetrahedrons.
            // So drawing the diagonals IS drawing the edges.
            // So this is correct.
        });
    }

    // Abstract iterator to reduce boilerplate
    static generateStrutLattice(params, cellFunction) {
        const { width, height, depth, cellSize, wallThickness } = params;
        // radius is now calculated per cell or passed to function
        const baseRadius = wallThickness / 2;
        const geometries = [];

        const nx = Math.floor(width / cellSize);
        const ny = Math.floor(height / cellSize);
        const nz = Math.floor(depth / cellSize);

        for (let x = 0; x < nx; x++) {
            for (let y = 0; y < ny; y++) {
                for (let z = 0; z < nz; z++) {
                    // Calculate density for cell center
                    // We map grid index back to world position for density calc
                    const cx = x * cellSize - width / 2 + cellSize / 2;
                    const cy = y * cellSize - height / 2 + cellSize / 2;
                    const cz = z * cellSize - depth / 2 + cellSize / 2;

                    const density = this.getDensityFactor(params, cx, cy, cz);
                    const radius = baseRadius * density;

                    // Pass the jittered cell origin and the radius to the cell function
                    // The cell function will then add its internal offsets to this jittered origin.
                    // This means nodes *within* a cell will jitter together, but nodes *shared* between cells (e.g., corners)
                    // will only jitter based on the cell they are "defined" in.
                    // A more robust solution would involve a global map of jittered node positions.
                    const jitteredCellOrigin = this.getNode(x, y, z, cellSize, params);

                    const result = cellFunction(x, y, z, cellSize, geometries, radius, jitteredCellOrigin, params);
                    if (Array.isArray(result)) {
                        geometries.push(...result);
                    }
                }
            }
        }

        const validGeos = geometries.filter(g => g && g.attributes && g.attributes.position && g.attributes.position.count > 0);

        // Calculate Stats
        let totalVolume = 0;
        validGeos.forEach(g => {
            if (g.userData && g.userData.volume) {
                totalVolume += g.userData.volume;
            }
        });

        if (validGeos.length === 0) return new THREE.BufferGeometry();

        const merged = mergeGeometries(validGeos);
        merged.userData = {
            strutCount: geometries.length,
            volume: totalVolume
        };
        return merged;
    }

    // ... createStrut ...

    // ... generateCubic, generateBCC, generateOctet ...

    static generateDiamond(params) {
        return this.generateStrutLattice(params, (x, y, z, cellSize, geometries, radius, jitteredCellOrigin) => {
            const half = cellSize / 2;
            const q = cellSize / 4;
            // Use jitteredCellOrigin as the base for px, py, pz
            const px = jitteredCellOrigin.x;
            const py = jitteredCellOrigin.y;
            const pz = jitteredCellOrigin.z;

            // Diamond nodes in a unit cell
            // 000 group (Corners/Faces - FCC)
            const n000 = new THREE.Vector3(px, py, pz);
            const n110 = new THREE.Vector3(px + half, py + half, pz);
            const n101 = new THREE.Vector3(px + half, py, pz + half);
            const n011 = new THREE.Vector3(px, py + half, pz + half);

            // Internal group
            const i0 = new THREE.Vector3(px + q, py + q, pz + q);
            const i1 = new THREE.Vector3(px + 3 * q, py + 3 * q, pz + q);
            const i2 = new THREE.Vector3(px + 3 * q, py + q, pz + 3 * q);
            const i3 = new THREE.Vector3(px + q, py + 3 * q, pz + 3 * q);

            // Connections
            // Each internal node connects to 4 specific FCC nodes
            // i0 connects to (0,0,0) and Face centers?
            // i0 (1,1,1)q connects to (0,0,0) and (2,2,0)q, (2,0,2)q, (0,2,2)q

            geometries.push(this.createStrut(i0, n000, radius));
            geometries.push(this.createStrut(i0, n110, radius));
            geometries.push(this.createStrut(i0, n101, radius));
            geometries.push(this.createStrut(i0, n011, radius));

            // Only generating i0 and its connections might leave gaps?
            // Diamond has 8 corners, 6 face centers, 4 internal.
            // Total 8 atoms per cell.
            // We need to cover all 4 internal atoms connections.

            // i1 (3,3,1)q connects to?
            // (4,4,0) -> (1,1,0) offset? No.
            // Neighbors of (3,3,1) are (2,2,0), (4,4,0), (4,2,2)?
            // Let's rely on the fundamental bond: Center of sub-octant to corners of sub-octant?
            // Subcube approach: Divide cell into 8 small cubes.
            // 4 of them contain a center atom.
            // (0,0,0) subcube has center at (1,1,1)q.
            // (1,1,0) subcube -> corners at (2,2,0)q ...

            // Let's explicitly list connections for i1, i2, i3 to avoid thinking too hard about geometry on the fly.
            // i1 (3,3,1)q connects to:
            // (2,2,0)q -> n110
            // (4,4,0)q -> n110 of neighbor? (px+cellSize, py+cellSize, pz)
            // (4,2,2)q -> (px+cellSize, py+half, pz+half)
            // (2,4,2)q -> (px+half, py+cellSize, pz+half)

            // Wait, this is getting complex for edge cases.
            // Alternative: Diamond is just two FCC lattices shifted by (1/4, 1/4, 1/4).
            // And each node in one lattice is connected to 4 neighbors in the other.
            // Neighbors of (0,0,0) in A are (-1,-1,-1) in B? No.

            // Correct set for single cell generation (tileable):
            // i0 connects to n000, n110, n101, n011.
            // i1 connects to n110, p110(next), p100...

            // Let's just implement the 4 internal nodes connecting to their local surroundings.
            // We need reference to nodes at (cellSize) boundary.
            const n110_next = new THREE.Vector3(px + cellSize, py + cellSize, pz); // corner?

            // Let's use relative vectors from internal points.
            // Each internal point connects to 4 corners of its local 2q x 2q box?
            // Yes. i0 is center of box from (0,0,0) to (2,2,2)q. Corners are (0,0,0), (2,2,0), (2,0,2), (0,2,2).
            // These are vertices of the tetrahedron.

            // i1 is center of box from (2,2,0) to (4,4,2)q ?
            // i1 is at (3,3,1)q. Box corners: (2,2,0), (4,4,0), (4,2,2), (2,4,2).
            // (2,2,0) is n110.
            // (4,4,0) is corner (p110 of this cell, but simplified).
            // Let's just define the target points.

            const targets_i1 = [
                new THREE.Vector3(px + half, py + half, pz), // n110
                new THREE.Vector3(px + cellSize, py + cellSize, pz),
                new THREE.Vector3(px + cellSize, py + half, pz + half),
                new THREE.Vector3(px + half, py + cellSize, pz + half)
            ];
            targets_i1.forEach(t => geometries.push(this.createStrut(i1, t, radius)));

            const targets_i2 = [
                new THREE.Vector3(px + half, py, pz + half), // n101
                new THREE.Vector3(px + cellSize, py, pz + cellSize),
                new THREE.Vector3(px + cellSize, py + half, pz + half),
                new THREE.Vector3(px + half, py - half, pz + cellSize) // wait, wrapping?
                // No, standard within cell logic.
                // (3,1,3)q.
                // Neighbors: (2,0,2)q -> n101.
                // (4,0,4)q -> Corner (1,0,1).
                // (4,2,2)q -> Face center (1, 0.5, 0.5).
                // (2,2,4)q -> Face center (0.5, 0.5, 1).
            ];
            // Re-defining for clarity
            const p_101 = new THREE.Vector3(px + cellSize, py, pz + cellSize);
            const f_1_y_z = new THREE.Vector3(px + cellSize, py + half, pz + half);
            const f_x_1_z = new THREE.Vector3(px + half, py + cellSize, pz + half);
            const f_x_y_1 = new THREE.Vector3(px + half, py + half, pz + cellSize);

            // i2 (3, 1, 3)q
            geometries.push(this.createStrut(i2, n101, radius)); // (2,0,2)q
            geometries.push(this.createStrut(i2, p_101, radius)); // (4,0,4)q
            geometries.push(this.createStrut(i2, f_1_y_z, radius)); // (4,2,2)q -> Wait, f_1_y_z is at (1, 0.5, 0.5). (4,2,2)q is correct.
            geometries.push(this.createStrut(i2, f_x_y_1, radius)); // (2,2,4)q -> (0.5, 0.5, 1). Correct.

            // i3 (1, 3, 3)q
            geometries.push(this.createStrut(i3, n011, radius)); // (0,2,2)q
            geometries.push(this.createStrut(i3, new THREE.Vector3(px, py + cellSize, pz + cellSize), radius)); // (0,4,4)q
            geometries.push(this.createStrut(i3, f_x_1_z, radius)); // (2,4,2)q
            geometries.push(this.createStrut(i3, f_x_y_1, radius)); // (2,2,4)q
        });
    }

    static generateKelvin(params) {
        return this.generateStrutLattice(params, (x, y, z, cellSize, geometries, radius) => {
            // Kelvin cell (Textrakaidecahedron) centered in the voxel.
            // Scale factor to fit in cellSize.
            const s = cellSize / 4;
            const cx = x * cellSize - params.width / 2 + cellSize / 2;
            const cy = y * cellSize - params.height / 2 + cellSize / 2;
            const cz = z * cellSize - params.depth / 2 + cellSize / 2;
            const center = new THREE.Vector3(cx, cy, cz);

            const points = [];

            // Group 1: x=0. (0, ±1, ±2) and (0, ±2, ±1)
            [[1, 2], [2, 1]].forEach(([a, b]) => {
                [-1, 1].forEach(sy => {
                    [-1, 1].forEach(sz => {
                        points.push(new THREE.Vector3(0, a * sy * s, b * sz * s));
                    });
                });
            });
            // Group 2: y=0
            [[1, 2], [2, 1]].forEach(([a, b]) => {
                [-1, 1].forEach(sx => {
                    [-1, 1].forEach(sz => {
                        points.push(new THREE.Vector3(a * sx * s, 0, b * sz * s));
                    });
                });
            });
            // Group 3: z=0
            [[1, 2], [2, 1]].forEach(([a, b]) => {
                [-1, 1].forEach(sx => {
                    [-1, 1].forEach(sy => {
                        points.push(new THREE.Vector3(a * sx * s, b * sy * s, 0));
                    });
                });
            });

            // Connect neighbors based on canonical (unjittered) distance
            const limit = 2 * s * s * 1.01;
            const limitMin = 2 * s * s * 0.99;

            for (let i = 0; i < points.length; i++) {
                for (let j = i + 1; j < points.length; j++) {
                    const d2 = points[i].distanceToSquared(points[j]);
                    if (d2 > limitMin && d2 < limit) {
                        // Calculate absolute positions
                        const v1 = points[i].clone().add(center);
                        const v2 = points[j].clone().add(center);

                        // Apply Jitter (Spatial)
                        const j1 = this.getSpatialJitter(v1, cellSize, params.jitter);
                        const j2 = this.getSpatialJitter(v2, cellSize, params.jitter);

                        geometries.push(this.createStrut(j1, j2, radius));
                    }
                }
            }
        });
    }


    static createStrut(vStart, vEnd, radius) {
        const distance = vStart.distanceTo(vEnd);
        const position = vEnd.clone().add(vStart).divideScalar(2);

        // Cylinder (Strut body)
        // Set openEnded = true because we are capping with spheres
        const geometry = new THREE.CylinderGeometry(radius, radius, distance, 6, 1, true);

        // Orientation
        const orientation = new THREE.Matrix4();
        const offsetRotation = new THREE.Matrix4();
        orientation.lookAt(vStart, vEnd, new THREE.Vector3(0, 1, 0));
        offsetRotation.makeRotationX(Math.PI / 2);
        orientation.multiply(offsetRotation);
        geometry.applyMatrix4(orientation);
        geometry.translate(position.x, position.y, position.z);

        // Spheres (Joints)
        // Low poly spheres for performance (8 width seg, 6 height seg)
        const sphereGeo = new THREE.SphereGeometry(radius, 8, 6);
        const sphereStart = sphereGeo.clone();
        sphereStart.translate(vStart.x, vStart.y, vStart.z);

        const sphereEnd = sphereGeo.clone();
        sphereEnd.translate(vEnd.x, vEnd.y, vEnd.z);

        // Merge
        const merged = mergeGeometries([geometry, sphereStart, sphereEnd]);

        // Stats (Approximate, ignores overlap)
        merged.userData = {
            volume: (Math.PI * radius * radius * distance) + (2 * (4 / 3 * Math.PI * Math.pow(radius, 3)))
        };

        return merged;
    }

    static generateCubic(params) {
        return this.generateStrutLattice(params, (x, y, z, cellSize, geometries, radius, jitteredCellOrigin) => {
            const { width, height, depth } = params;
            const nx = Math.floor(width / cellSize);
            const ny = Math.floor(height / cellSize);
            const nz = Math.floor(depth / cellSize);

            const n000 = jitteredCellOrigin; // Node at (x, y, z)

            // Connect to neighbors in + directions
            if (x < nx - 0.001) { // -0.001 for float safety
                const n100 = this.getNode(x + 1, y, z, cellSize, params);
                geometries.push(this.createStrut(n000, n100, radius));
            }
            if (y < ny - 0.001) {
                const n010 = this.getNode(x, y + 1, z, cellSize, params);
                geometries.push(this.createStrut(n000, n010, radius));
            }
            if (z < nz - 0.001) {
                const n001 = this.getNode(x, y, z + 1, cellSize, params);
                geometries.push(this.createStrut(n000, n001, radius));
            }
        });
    }

    static generateBCC(params) {
        return this.generateStrutLattice(params, (x, y, z, cellSize, geometries, radius, jitteredCellOrigin) => {
            // BCC: Connect Corners to Center.
            // Corners: (x,y,z), (x+1,y,z)... all jittered.
            const n000 = jitteredCellOrigin;
            const n100 = this.getNode(x + 1, y, z, cellSize, params);
            const n010 = this.getNode(x, y + 1, z, cellSize, params);
            const n001 = this.getNode(x, y, z + 1, cellSize, params);
            const n110 = this.getNode(x + 1, y + 1, z, cellSize, params);
            const n101 = this.getNode(x + 1, y, z + 1, cellSize, params);
            const n011 = this.getNode(x, y + 1, z + 1, cellSize, params);
            const n111 = this.getNode(x + 1, y + 1, z + 1, cellSize, params);

            // Center: Average of corners (preserves topology under twist/jitter)
            const center = new THREE.Vector3()
                .add(n000).add(n100).add(n010).add(n001)
                .add(n110).add(n101).add(n011).add(n111)
                .multiplyScalar(0.125);

            // Connect center to all 8 corners
            geometries.push(this.createStrut(center, n000, radius));
            geometries.push(this.createStrut(center, n100, radius));
            geometries.push(this.createStrut(center, n010, radius));
            geometries.push(this.createStrut(center, n001, radius));
            geometries.push(this.createStrut(center, n110, radius));
            geometries.push(this.createStrut(center, n101, radius));
            geometries.push(this.createStrut(center, n011, radius));
            geometries.push(this.createStrut(center, n111, radius));

            // Note: This logic works per cell. Neighbor cells will share the "Corner" nodes (because getNode is consistent)
            // but will generate their own Center and struts.
            // Result is a fully connected BCC mesh.
        });
    }

    static generateOctet(params) {
        // Octet-Truss: Face-Centered Cubic (FCC) with tetrahedral core.
        // Nodes at corners + face centers. 
        // 12 struts connecting face centers to neighbors? 
        // A common construction is forming regular octahedron + tetrahedrons.
        // It connects:
        // 1. Edges of the cube? No.
        // 2. Face diagonals.

        return this.generateStrutLattice(params, (x, y, z, cellSize, geometries, radius) => {
            const half = cellSize / 2;
            const px = x * cellSize - params.width / 2;
            const py = y * cellSize - params.height / 2;
            const pz = z * cellSize - params.depth / 2;

            // Nodes
            const p000 = new THREE.Vector3(px, py, pz);
            const p100 = new THREE.Vector3(px + cellSize, py, pz);
            const p010 = new THREE.Vector3(px, py + cellSize, pz);
            const p001 = new THREE.Vector3(px, py, pz + cellSize);
            const p110 = new THREE.Vector3(px + cellSize, py + cellSize, pz);
            const p101 = new THREE.Vector3(px + cellSize, py, pz + cellSize);
            const p011 = new THREE.Vector3(px, py + cellSize, pz + cellSize);
            const p111 = new THREE.Vector3(px + cellSize, py + cellSize, pz + cellSize);

            // Face centers
            const f_xy_0 = new THREE.Vector3(px + half, py + half, pz);
            const f_xy_1 = new THREE.Vector3(px + half, py + half, pz + cellSize);
            const f_yz_0 = new THREE.Vector3(px, py + half, pz + half);
            const f_yz_1 = new THREE.Vector3(px + cellSize, py + half, pz + half);
            const f_xz_0 = new THREE.Vector3(px + half, py, pz + half);
            const f_xz_1 = new THREE.Vector3(px + half, py + cellSize, pz + half);

            // Octet consists of 12 edges of the internal octahedron connecting face centers.
            // Plus edges connecting corners to face centers? 
            // Standard Octet Truss connects nodes at integer coordinates (0,0,0) with (1,1,0), (1,0,1), (0,1,1) etc.
            // Wait, simpler approach: Octet is 12 face diagonals of a cube.

            // X-Face diagonals
            geometries.push(this.createStrut(p000, p011, radius)); // Diagonal on YZ plane? No.
            // Face diagonals:
            // XY plane
            geometries.push(this.createStrut(p000, p110, radius));
            geometries.push(this.createStrut(p100, p010, radius));

            // YZ plane
            geometries.push(this.createStrut(p000, p011, radius));
            geometries.push(this.createStrut(p010, p001, radius));

            // XZ plane
            geometries.push(this.createStrut(p000, p101, radius));
            geometries.push(this.createStrut(p100, p001, radius));

            // NOTE: This creates "half" an octet structure density.
            // Actually, if we tile this, we get crossings. 
            // Ideally we do this per cell. But face diagonals on one cell are shared with neighbors.
            // We can just generate all 6 face diagonals for the + direction faces?
            // No, to be fully connected we need to be careful.
            // The 12 face diagonals of a standard cube form the Octet graph.
            // Let's enable all 12?
            // XY
            // geometries.push(this.createStrut(p000, p110, radius));
            // geometries.push(this.createStrut(p100, p010, radius));
            // // YZ
            // geometries.push(this.createStrut(p000, p011, radius));
            // geometries.push(this.createStrut(p010, p001, radius));
            // // XZ
            // geometries.push(this.createStrut(p000, p101, radius));
            // geometries.push(this.createStrut(p100, p001, radius));
            // 
            // Wait, if we do this for every cell, lines are duplicated.
            // Optimization: only generate for 3 faces (e.g. Front, Bottom, Left)? 
            // But diagonals are internal to the face.
            // Correct logic: A cubic cell has 6 faces. We can generate diagonals for 3 specific faces (XY, YZ, ZX) at (0,0,0).
            // But that leaves gaps at boundaries.
            // Trivial approach: Generate all 6 diagonals for the cube. Overlaps are fine (merged later).
            // Actually, `mergeGeometries` does NOT remove duplicates.
            // We should try to be unique.

            // Unique set:
            // For a node at (x,y,z), connect to (x+1, y+1, z) and (x+1, y, z+1) and (x, y+1, z+1) etc.
            // 12 neighbors in FCC.
            // Let's stick to generating per-cell "contained" geometry for simplicity, even if slightly redundant at edges.
            // actually, face diagonals shared between two cells.

            // Revised Simple Octet:
            // Within this cell, draw the localized Octahedron in the center?
            // No, Octet truss is literally lines connecting integer coordinates.
            // Let's generate the 6 Face Diagonals for this cell.

            if (true) {
                // XY Bottom
                geometries.push(this.createStrut(p000, p110, radius));
                geometries.push(this.createStrut(p100, p010, radius));
                // YZ Left
                geometries.push(this.createStrut(p000, p011, radius));
                geometries.push(this.createStrut(p010, p001, radius));
                // XZ Back
                geometries.push(this.createStrut(p000, p101, radius));
                geometries.push(this.createStrut(p100, p001, radius));

                // We also need the other faces?
                // No, if we iterate x,y,z, the "Top" face of this cell is the "Bottom" face of y+1.
                // So we only need to generate 3 faces per cell.
                // XY at z=0 (Front) -> No, XY is z constant.
                // We do:
                // 1. XY Face at z=0 (p000, p100, p110, p010)
                // 2. XZ Face at y=0
                // 3. YZ Face at x=0

                // Face XY (z=0)
                geometries.push(this.createStrut(p000, p110, radius));
                geometries.push(this.createStrut(p100, p010, radius));

                // Face XZ (y=0)
                geometries.push(this.createStrut(p000, p101, radius));
                geometries.push(this.createStrut(p100, p001, radius));

                // Face YZ (x=0)
                geometries.push(this.createStrut(p000, p011, radius));
                geometries.push(this.createStrut(p010, p001, radius));

                // We also need to handle the boundary faces at x=nx, y=ny, z=nz?
                // Unlike struts (which are on edges), diagonals are ON the face.
                // If we only do the "min" faces (x=0 relative to cell), we miss the "max" faces of the very last cells.
                // So we must generate closing faces if at boundary.

                if (z === Math.floor(params.depth / cellSize) - 1) { // Last Z layer
                    const off = new THREE.Vector3(0, 0, cellSize);
                    geometries.push(this.createStrut(p000.clone().add(off), p110.clone().add(off), radius));
                    geometries.push(this.createStrut(p100.clone().add(off), p010.clone().add(off), radius));
                }
                if (y === Math.floor(params.height / cellSize) - 1) { // Last Y row
                    const off = new THREE.Vector3(0, cellSize, 0);
                    geometries.push(this.createStrut(p000.clone().add(off), p101.clone().add(off), radius));
                    geometries.push(this.createStrut(p100.clone().add(off), p001.clone().add(off), radius));
                }
                if (x === Math.floor(params.width / cellSize) - 1) { // Last X col
                    const off = new THREE.Vector3(cellSize, 0, 0);
                    geometries.push(this.createStrut(p000.clone().add(off), p011.clone().add(off), radius));
                    geometries.push(this.createStrut(p010.clone().add(off), p001.clone().add(off), radius));
                }
            }
        });
    }

    // Abstract iterator to reduce boilerplate
    static generateStrutLattice(params, cellFunction) {
        const { width, height, depth, cellSize, wallThickness } = params;
        const baseRadius = wallThickness / 2;
        const geometries = [];

        const nx = Math.floor(width / cellSize);
        const ny = Math.floor(height / cellSize);
        const nz = Math.floor(depth / cellSize);

        for (let x = 0; x < nx; x++) {
            for (let y = 0; y < ny; y++) {
                for (let z = 0; z < nz; z++) {
                    const cx = x * cellSize - width / 2 + cellSize / 2;
                    const cy = y * cellSize - height / 2 + cellSize / 2;
                    const cz = z * cellSize - depth / 2 + cellSize / 2;

                    // Variable Density
                    const density = this.getDensityFactor(params, cx, cy, cz);
                    const radius = baseRadius * density;

                    // Jittered Cell Origin
                    // We need to pass params to getNode as well
                    const jitteredCellOrigin = this.getNode(x, y, z, cellSize, params);

                    // Call cell function with extended context
                    const result = cellFunction(x, y, z, cellSize, geometries, radius, jitteredCellOrigin, params);

                    if (Array.isArray(result)) {
                        geometries.push(...result);
                    }
                }
            }
        }

        if (geometries.length === 0) return new THREE.BufferGeometry();

        // Calculate Stats
        let totalVolume = 0;
        geometries.forEach(g => {
            if (g.userData && g.userData.volume) {
                totalVolume += g.userData.volume;
            }
        });

        const merged = mergeGeometries(geometries);
        merged.userData = {
            strutCount: geometries.length,
            volume: totalVolume
        };
        return merged;
    }
}

