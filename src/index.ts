import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createOllamaProviderExtension, type OllamaProviderPi, type OllamaProviderExtensionOptions } from "./extension.ts";
import type { PiEventSink } from "./stream.ts";
export type { OllamaProviderMode } from "./config.ts";

// The only module that imports Pi values. Everything it wires is structural,
// so the provider's tests run without a Pi installation.
export function createOllamaExtension(options: Omit<OllamaProviderExtensionOptions<PiEventSink>, "configDirName" | "createEventStream"> = {}) {
	const extension = createOllamaProviderExtension({
		...options, configDirName: CONFIG_DIR_NAME,
		// The transport emits JSON-parsed tool arguments. Pi's JsonObject type is
		// narrower than our structural view; real-host event tests pin this bridge.
		createEventStream: createAssistantMessageEventStream as unknown as () => PiEventSink,
	});
	return (pi: ExtensionAPI): Promise<void> => extension(pi as unknown as OllamaProviderPi);
}
export default createOllamaExtension();
