import type { RecipeContent } from "../api.ts";

export type OfficialSeed = {
  recipe_id: string;
  name: string;
  kind: string;
  source: string;
  content: RecipeContent;
};

const official: OfficialSeed[] = [
  {
    "recipe_id": "official:hot-balanced",
    "name": "官方·均衡热冲",
    "kind": "hot",
    "source": "official",
    "content": {
      "name": "官方·均衡热冲",
      "kind": "hot",
      "dripper": "Omni Dripper 2",
      "dose_g": 15,
      "grind": 58,
      "ratio": 16,
      "water_ml": 240,
      "hot_water_ml": 240,
      "time": "2:30-3:05",
      "note": "xBloom 风格起始配方（Skill 模板），可按豆子微调。",
      "pours": [
        { "label": "Bloom", "ml": 45, "temp_c": 92, "pattern": "spiral", "vibration": "after", "pause_s": 35, "rpm": 90, "flow_ml_s": 3.0 },
        { "label": "Main", "ml": 105, "temp_c": 92, "pattern": "spiral", "vibration": "none", "pause_s": 10, "rpm": 90, "flow_ml_s": 3.2 },
        { "label": "Finish", "ml": 90, "temp_c": 91, "pattern": "circular", "vibration": "none", "pause_s": 0, "rpm": 90, "flow_ml_s": 3.2 }
      ]
    }
  },
  {
    "recipe_id": "official:flash-bright",
    "name": "官方·明亮闪萃",
    "kind": "flash-brew",
    "source": "official",
    "content": {
      "name": "官方·明亮闪萃",
      "kind": "flash-brew",
      "dripper": "Omni Dripper 2",
      "dose_g": 15,
      "grind": 52,
      "ratio": 10,
      "water_ml": 240,
      "hot_water_ml": 150,
      "ice_g": 90,
      "time": "2:00-2:40",
      "note": "接杯预放 90g 冰，机器按热冲程序出热液。",
      "pours": [
        { "label": "Bloom", "ml": 40, "temp_c": 94, "pattern": "spiral", "vibration": "after", "pause_s": 35, "rpm": 100, "flow_ml_s": 3.0 },
        { "label": "Main", "ml": 60, "temp_c": 93, "pattern": "spiral", "vibration": "none", "pause_s": 8, "rpm": 100, "flow_ml_s": 3.2 },
        { "label": "Finish", "ml": 50, "temp_c": 92, "pattern": "circular", "vibration": "none", "pause_s": 0, "rpm": 100, "flow_ml_s": 3.2 }
      ]
    }
  },
  {
    "recipe_id": "official:light-filter",
    "name": "官方·浅烘滤泡",
    "kind": "hot",
    "source": "official",
    "content": {
      "name": "官方·浅烘滤泡",
      "kind": "hot",
      "dripper": "Omni Dripper 2",
      "dose_g": 15,
      "grind": 62,
      "ratio": 16.5,
      "water_ml": 248,
      "hot_water_ml": 248,
      "time": "2:40-3:20",
      "note": "略粗研磨、偏高水温，适合浅烘水果调。",
      "pours": [
        { "label": "Bloom", "ml": 50, "temp_c": 94, "pattern": "spiral", "vibration": "both", "pause_s": 40, "rpm": 85, "flow_ml_s": 2.8 },
        { "label": "Main", "ml": 110, "temp_c": 93, "pattern": "spiral", "vibration": "none", "pause_s": 12, "rpm": 85, "flow_ml_s": 3.0 },
        { "label": "Finish", "ml": 88, "temp_c": 92, "pattern": "circular", "vibration": "none", "pause_s": 0, "rpm": 85, "flow_ml_s": 3.0 }
      ]
    }
  },
  {
    "recipe_id": "official:medium-sweet",
    "name": "官方·中烘甜感",
    "kind": "hot",
    "source": "official",
    "content": {
      "name": "官方·中烘甜感",
      "kind": "hot",
      "dripper": "Omni Dripper 2",
      "dose_g": 16,
      "grind": 55,
      "ratio": 15,
      "water_ml": 240,
      "hot_water_ml": 240,
      "time": "2:20-2:55",
      "note": "略细研磨、中等流速，突出焦糖/巧克力甜感。",
      "pours": [
        { "label": "Bloom", "ml": 48, "temp_c": 91, "pattern": "spiral", "vibration": "after", "pause_s": 30, "rpm": 95, "flow_ml_s": 3.0 },
        { "label": "Main", "ml": 100, "temp_c": 90, "pattern": "spiral", "vibration": "none", "pause_s": 8, "rpm": 95, "flow_ml_s": 3.4 },
        { "label": "Finish", "ml": 92, "temp_c": 90, "pattern": "center", "vibration": "none", "pause_s": 0, "rpm": 95, "flow_ml_s": 3.4 }
      ]
    }
  },
  {
    "recipe_id": "official:tea-green",
    "name": "官方·绿茶（茶程序）",
    "kind": "tea",
    "source": "official",
    "content": {
      "name": "官方·绿茶",
      "kind": "tea",
      "leaf_g": 4,
      "output_ml_per_steep": 120,
      "pours": [
        { "label": "Steep 1", "ml": 80, "temp_c": 85, "pattern": "center", "pause_s": 25, "flow_ml_s": 3.0 },
        { "label": "Steep 2", "ml": 100, "temp_c": 85, "pattern": "center", "pause_s": 20, "flow_ml_s": 3.0 }
      ]
    }
  }
]
;

export default official;
