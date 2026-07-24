import type { RecipeContent } from "../api";

export type OfficialSeed = {
  recipe_id: string;
  name: string;
  kind: string;
  source: string;
  content: RecipeContent;
};

const official: OfficialSeed[] = []
;

export default official;
