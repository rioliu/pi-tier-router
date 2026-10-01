# Local Router Research

Findings from [Awesome-Routing-LLMs](https://github.com/MilkThink-Lab/Awesome-Routing-LLMs)
(176★, ~120 papers) and the papers most relevant to a **local, zero-cost routing layer** that
decides flash-vs-pro per prompt, before any model call.

Goal: per-prompt routing in the agent loop, layered `local -> flash rating -> Jev`, with ≥95%
of prompts decided by layer 0.

---

## 1. The taxonomy (what the list teaches)

| Family | When it decides | Signals used | Fit for us |
|---|---|---|---|
| **Pre-judgment routing** — feature matching / predictive scoring / constrained optimization | before generation, from the query alone | prompt features, learned scorers, budgets | **this is our layer 0** |
| **Verification routing** — self-assessment / collaborative generation | during/after generation | model confidence, partial output | our existing flash self-rating (L1); mid-turn escalation = deferred |
| **Memory-based routing** — retrieval (kNN) / graph | before generation, conditioned on history | past queries + observed outcomes | **phase 2**: local decision log, user overrides as labels |
| **System analysis** — benchmarks, theory, safety | n/a | RouterBench/RouterEval metrics | how we *measure* coverage and accuracy |

Pre-judgment splits into three strategies — feature matching (align query to model capability),
predictive scoring (parametric estimator of expected utility), constrained optimization
(budget/latency-aware selection). All three are runnable locally; none requires calling an LLM.

## 2. Papers that directly shape the design

**Local/prompt-feature routing**
- **RouteLLM** (ICLR'24, arXiv:2406.18665) — routers trained on pairwise preference data pick
  strong vs weak LLM; several cheap router forms (similarity weighting, classifier, matrix
  factorization). Framing we reuse: *preference labels can come from user behavior, not just
  benchmarks.*
- **Arch-Router** (arXiv:2506.16655) — matches queries to user-defined domains instead of
  scoring capability. Validates intent-class matching (fix/explain/deploy/...) as a routing
  signal rather than a difficulty regression.
- **Tryage** (arXiv:2308.11601), **Prompt Difficulty Prediction** (arXiv:2511.03808) —
  lightweight difficulty predictors assign each query to the smallest model likely to succeed;
  features from the prompt itself.
- **Agent-as-a-Router / ACRouter** (arXiv:2606.22902) and **Routesplain** (arXiv:2511.09373) —
  routing *for coding tasks* specifically.

**Confidence-gated two-tier (the abstain pattern)**
- **Uncertainty-Based Two-Tier Selection** (COLM'24, arXiv:2405.02134) — cheap tier decides,
  an expensive decision criterion is consulted **only when uncertain**. This is exactly the
  proposed `local -> flash -> Jev` chain; we are inserting a cheaper first tier.
- **Confident or Seek Stronger** (NeurIPS-W'25, arXiv:2502.04428), **AutoMix** (NeurIPS'24),
  **SATER** (EMNLP'25), **CP-Router** (AAAI'26) — threshold-triggered escalation, measured as
  *risk vs coverage*. The ≥95% target is therefore a **coverage** number on a risk-coverage
  curve, not an accuracy claim: the router may abstain.
- **FORC / meta-modeling** (WSDM'24) — a meta-model calling other models as judges; our Jev
  layer is a cheap version of this.

**Memory / kNN (training-free adaptation)**
- **"When Simple kNN Beats Complex Learned Routers"** (arXiv:2505.12601) — a well-tuned kNN over
  stored history matches or beats learned routers across tasks, with no training. Best single
  justification for **phase 2: kNN over our own logged (features -> decision) history**.
- **Eagle** (NeurIPS-W'24), **PORT** (NeurIPS-W'25), **ProxRouter** (arXiv:2510.09852) —
  training-free retrieval routers, robust to outliers via proximity weighting.

**Simple/interpretable scorers**
- **IR3DE: a linear router** (ICML-W'26), **RouterDC** (NeurIPS'24) — linear/contrastive scorers
  are competitive and inspectable → phase 3 logistic regression fit offline on our logs.

**Benchmarks / risks**
- **RouterBench** (ICML-W'24), **RouterEval** (EMNLP'25), **RouterArena** (ICLR-W'25) — metrics:
  quality, cost, latency, robustness; report coverage + accuracy, not just one number.
- **DSC: fragility of router LLMs** (EACL'26, arXiv:2504.07113) — routers degrade under
  distribution shift → keep the abstain path and monitor logged agreement.
- **R2A** (ACL'26) — routers are an adversarial surface; low risk for personal use, but it
  argues against brittle keyword-only rules being trusted blindly.
- **Router-to-oracle gap decomposition** (arXiv:2607.03436) — routing cannot exceed the union of
  its pool; set expectations honestly.

## 3. Design derived from the findings

```
turn begins (before_agent_start, prompt text in hand)
  │
  ├─ L0  local feature router  (0 ms, 0 tokens, deterministic)
  │      score = sigmoid(Σ wᵢ·xᵢ) over prompt features
  │      score ≥ τ_hi → pro        score ≤ τ_lo → flash        else → abstain
  │
  ├─ L1  flash self-rating      (existing, only on abstain; conf ≥ 0.8 final)
  │
  └─ L2  Jev                    (existing, only if flash is unsure and key set)
         │
         └─ otherwise keep current model (existing fail-open)
```

- **Hook**: `before_agent_start` — fires once per run and carries the prompt text
  (Jev: 0.98, decisive). The chosen rating is stored in router state and used by `route()` for
  **every API call of that turn** (including tool-loop continuations via `turn_end`), so routing
  is evaluated per prompt, not per session.
- **Layer-0 features** (all local, regex/statistical): length, code fences, file paths,
  stack-trace/error markers, non-English text, intent classes (explain/read = flash-leaning;
  fix/debug, architecture/migration/concurrency/security = pro-leaning; trivial commands =
  flash with high confidence), multi-file/multi-step markers, ambiguity (no verb, too short).
- **Abstain band** τ_lo..τ_hi is the whole point: coverage is *measured*, then grown by adding
  rules / kNN, never by forcing decisions (papers: risk-coverage framing).
- **Stats**: per-decision log (feature digest, layer that decided, outcome, agreement when
  escalated) in the config dir; `/auto-router status` reports local coverage %, escalation rate,
  agreement. User `/model` overrides are recorded as preference labels (RouteLLM framing).
- **Phase 2**: kNN over the decision log (arXiv:2505.12601) — fixes cases where hand rules
  abstain; no training.
- **Phase 3**: offline logistic fit on accumulated labels, weights shipped in code
  (IR3DE-style linear router).

## 4. What we deliberately do not take

- **Collaborative/token-level routing** (R2R, FusionRoute, Router-R1): requires streaming
  partial outputs between models mid-generation — the extension API exposes boundaries, not
  token-level handoff; also our virtual-model model already restricts us to one model per call.
- **Verification-routing mid-turn escalation** (AutoMix/STEER): escalate *after* seeing a weak
  partial answer. Feasible later via `turn_end` continuation (`{ continue: true }`), but it
  changes the contract from "pick a model" to "re-decide after a turn" — defer until layer 0 is
  measured.
- **Graph-based memory routers** (GraphRouter, GMTRouter): GNN over interaction graphs — heavy,
  no local training path.
- **Constrained optimization / RL policies** (CARROT, xRouter, PROTEUS): budget-objective
  optimization; our objective is binary flash/pro with a fixed cost preference.

## 5. Honest feasibility note

Jev's calibration on "≥95% decided locally *and* agreeing with the flash+Jev chain" was P=0.40
— no signal, i.e. not to be assumed. The literature supports that a two-tier abstaining router
works, and that coding-agent prompts have strong regularities (errors/multi-file/design → pro;
lookups/small edits/explanations → flash), so ≥95% **coverage** is plausible — but it must be
**measured from logs and grown incrementally** (phase 1 rules → phase 2 kNN → phase 3 linear),
reporting coverage and agreement separately. Shipping the abstain band first is what makes that
safe.
