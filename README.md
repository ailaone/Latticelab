# LatticeLab

LatticeLab is an interactive 3D browser application for generating, visualizing, and exporting complex lattice structures for additive manufacturing (3D printing).

## Features

- **Lattice Types**: Cubic, Octet, BCC, Diamond, Kelvin, Gyroid (Surface-based).
- **Advanced Geometry**:
  - **Variable Density**: Define density gradients along X, Y, or Z axes.
  - **Jitter**: Apply organic randomness to node positions while maintaining topology.
- **Fabrication Stats**: Real-time estimates of element count and volume.
- **Tools**: Copy/Paste configurations to share settings.
- **Export**: One-click OBJ export for compatibility with Slicers.

## Installation

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run local development server:
   ```bash
   npm run dev
   ```
4. Build for production:
   ```bash
   npm run build
   ```

## Usage

1. **Lattice Type**: Choose from the dropdown (e.g., Gyroid for TPMS, Octet for high strength).
2. **Cell Properties**: Adjust `Cell Size` and `Wall Thickness`.
3. **Advanced Geometry**:
   - Enable "Variable Density" to create gradients (e.g., stronger base, lighter top).
   - Use "Jitter" to create disordered, foam-like structures.
4. **Appearance**: Select a Material Preset (Titanium, Nylon, etc.) or customize colors.
5. **Export**: Click "Download OBJ" to save the model.

## Technology

- **Three.js**: 3D Rendering engine.
- **Vite**: Build tool.
- **Lil-gui**: User Interface.

## License

MIT
