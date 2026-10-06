/**
 * Installs the egress block (src/egress.ts) as a side effect of being imported. The Worker
 * entry imports this first, and ES modules evaluate in import order, so the block is in
 * place before any of Kestrel's modules are even evaluated, let alone run.
 */

import { blockEgress } from "./egress";

blockEgress();
