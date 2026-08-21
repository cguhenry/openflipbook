# B0 OpenClaw OAuth Provider Slice

B0 is a private NAS capability proof, not product activation. The reusable probe
normalizes three controlled OpenClaw outputs into the existing `RenderedPage`
Pydantic contract:

1. one `openai/gpt-5.4-mini` PagePlan response;
2. one low-quality, single `openai/gpt-image-2` illustration;
3. one raw multimodal `openai/gpt-5.4-mini` alignment response.

The probe pins `thinking=off`, requests a 1536x1024 landscape image with count 1,
adds a hard no-text/opaque-background instruction, and writes a persistent
no-rerun ledger before each live command. The local resolver check verifies that
the center of every aligned bbox can resolve without another model call.

Before `--execute-live`, the operator must verify from local OpenClaw state that
the selected OpenAI route is ChatGPT/Codex OAuth-only, the two models are locally
discoverable, and no API-key profile can be selected by fallback. The probe removes
ambient `OPENAI_API_KEY` and `CODEX_API_KEY` variables from child commands, but it
does not replace the required local auth-order gate.

The probe deliberately does not enable Gateway `/v1/responses`, add credentials,
or connect the live path to `/sse/generate` or `/play`. Live evidence belongs under
the external B0 workpack results directory and must never be committed.

## Focused verification

```bash
apps/modal-backend/.venv/bin/pytest -q \
  apps/modal-backend/tests/test_openclaw_contract.py \
  apps/modal-backend/tests/test_page_contract.py \
  apps/modal-backend/tests/test_mock_page_contract.py
bash scripts/test_b0_openclaw_probe_fake.sh
```

B1 still needs to choose and implement the runtime bridge from the product to
OpenClaw; B0 intentionally makes no such architecture decision.
