# Ideas for 3D visualization project

## General goal

1. Build a platform that could make fire test plans and have 3D visualizations
2. The platform have two variants: (1) an Html-based interactive webpage (temporary idea), which is a lightweight solution to draw the plans and have 3D visualizations; (2) an python-based program (packaged into a single exe file eventually), which is a more feature rich solution that contain features of all lightweight one and could potential further visualize the flame object into the test site in 3D (via external import of reconstructed 3D flame objects)

## Features

1. (both variant) draw(e.g., drag-in) in 2D for necessary fire test plan objects (could take the jpg image in the folder as an example, which might include RGB cameras, thermal cameras, fire burning base (with typical shapes like square, rectangle, circle, etc.), hood system on top, walls, etc.). Also the position and dimension of items could be adjusted when necessary.
2. (both variant) 3D visualization of the entire fire test plan (e.g., free drag/zoom, etc.)
3. (both variant) save and load fire test plans/configurations so that the finished fire test plan could be transferred to others
4. (python variant) import reconstructed 3D flame object (or a sequence of reconstructed 3D flame object over time), and then visualize in 3D (or 3D time sequence/video). This feature is not considered to be implemented as this time, and will be planned later when the reconstructed 3D flame object format is determined.