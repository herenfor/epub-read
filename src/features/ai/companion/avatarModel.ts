import type { Live2DModel } from "pixi-live2d-display/cubism4";

const root = "/__ai-companion/";
interface AvatarEmotion { zh: string; expression: string; motion: string | null }
export interface LocalAvatarProfile {
  name: string;
  modelUrl: string;
  defaultEmotion: string;
  idleMotionGroup: string;
  emotions: Record<string, AvatarEmotion>;
}
const sample: LocalAvatarProfile = { name: "Hiyori FREE · Live2D Inc.",
  modelUrl: root + "hiyori_free_zh/runtime/hiyori_free_t08.model3.json", defaultEmotion: "",
  idleMotionGroup: "Idle", emotions: {} };

function localAsset(file: string, parent = root): string {
  const url = new URL(file, new URL(parent, location.origin));
  if (url.origin !== location.origin || !url.pathname.startsWith(root)) throw new Error("Avatar must use local development assets");
  return url.pathname;
}

/** The optional local selection preserves existing sample installations without shipping any model. */
export async function loadLocalAvatar(signal: AbortSignal): Promise<LocalAvatarProfile> {
  const selection = await fetch(root + "avatar.json", { signal });
  if (selection.status === 404) return sample;
  if (!selection.ok) throw new Error("Cannot read local avatar selection");
  const config = await selection.json() as { name: string; interface: string };
  const interfaceUrl = localAsset(config.interface);
  const response = await fetch(interfaceUrl, { signal });
  if (!response.ok) throw new Error("Cannot read local avatar interface");
  const contract = await response.json() as { version: number; model: string; defaultEmotion: string;
    idleMotionGroup: string; emotions: Record<string, AvatarEmotion> };
  if (contract.version !== 1) throw new Error("Unsupported local avatar interface");
  return { name: config.name, modelUrl: localAsset(contract.model, interfaceUrl),
    defaultEmotion: contract.defaultEmotion, idleMotionGroup: contract.idleMotionGroup, emotions: contract.emotions };
}

/** Emotion names and motion files come from the model contract, never from filename guesses or LLM text. */
export async function applyAvatarEmotion(model: Live2DModel, profile: LocalAvatarProfile, name: string): Promise<void> {
  const emotion = profile.emotions[name];
  if (!emotion || !await model.expression(emotion.expression)) throw new Error("Cannot apply local avatar expression");
  const manager = model.internalModel.motionManager;
  if (!emotion.motion) {
    await model.motion(profile.idleMotionGroup, 0, 3);
    return;
  }
  for (const [group, definitions] of Object.entries(manager.definitions)) {
    const index = definitions?.findIndex(definition => manager.getMotionFile(definition) === emotion.motion) ?? -1;
    if (index >= 0) {
      if (!await model.motion(group, index, 3)) throw new Error("Cannot play local avatar motion");
      return;
    }
  }
  throw new Error("Local avatar motion is not registered");
}
