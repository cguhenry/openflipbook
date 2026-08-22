# B2 grounded live exploration

The NAS live path uses the authenticated OpenClaw Gateway for exactly three
model operations per child: one PagePlan response, one `image_generate` tool
call, and one hotspot-alignment response. Local SearXNG is the only grounding
source; the backend stores normalized source IDs, URLs, titles, and snippets
without fetching result pages.

Cancellation is application-level. The browser sends `generation_id` to the
cancel route before aborting its SSE reader; the backend checks the token at
each expensive stage and the image status poll. OpenClaw's current
`image_generate` tool exposes generation/status/media retrieval but no provider
cancel action. Therefore cancellation stops polling and discards late output;
it cannot claim to cancel provider-side compute that may already be running.

The live branch keeps the Gateway text/image model pins in compose and does not
use OpenAI API keys or provider fallback. Legacy providers retain their
existing paths when the live selector is not active.
