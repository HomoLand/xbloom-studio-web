from pathlib import Path

root = Path(__file__).resolve().parents[1]
j = (root / "src/data/officialRecipes.json").read_text(encoding="utf-8")
body = (
    'import type { RecipeContent } from "../api";\n\n'
    "export type OfficialSeed = {\n"
    "  recipe_id: string;\n"
    "  name: string;\n"
    "  kind: string;\n"
    "  source: string;\n"
    "  content: RecipeContent;\n"
    "};\n\n"
    f"const official: OfficialSeed[] = {j};\n\n"
    "export default official;\n"
)
(root / "src/data/officialRecipes.ts").write_text(body, encoding="utf-8")
print("wrote officialRecipes.ts")
