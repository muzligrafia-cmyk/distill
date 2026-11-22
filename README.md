# Distill

A 3-step Adobe Illustrator script that takes in complex vector artwork with overlapping parts and flattens it into a singular, "visible-only" artwork document. Overlaps and hidden parts are ignored in the final results.

Step 1: Select your artwork and run 1_DistillExport.jsx, this creates a .json file on your desktop containing the original, raw data of your artwork to be distilled.
Step 2: Run 2_RunDistill.bat (Windows-only), which outsources the calculations to Node (Node.js install required!) and creates another .json file on your desktop with the distilled data.
Step 3: Run 3_DistillImport.jsx, this looks for the distilled data's .json file and imports it into Illustrator over your existing artwork.

Current version keeps the engraving/marking lines #000000 RGB black, but the outline is RGB red, because I was lazy to change it, since it's such a niche script.
