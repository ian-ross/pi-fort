import { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * pi-fort
 *
 * VM-isolated fort for pi with automatic secret protection.
 * All pi tools (bash, read, write, edit) execute inside a Gondolin micro-VM.
 * Secrets never enter the VM; the HTTP proxy injects them on the wire.
 *
 * See README.md for architecture and configuration details.
 */

declare function parseFortArgs(args: string): string[];
declare function export_default(pi: ExtensionAPI): void;

export { export_default as default, parseFortArgs };
