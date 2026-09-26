# Persona Corpus Audit — who they are vs how they behave

**Scope:** all 89 files under `personas/` (civilian 40, junior 15, mid 14, senior 11,
principal 9). Method: full-corpus measurement (template reuse, circularity, run-on
detection, length stats) plus close reading of 8 files across all tiers.
**Date:** 2026-09-26. Follows the prompt audit (`persona-agent-prompt-audit.md`).

---

## 1. Summary

The corpus has real voices and the best method lenses (data scientist, incident
premortem, CFO) are genuinely good deliberators. But the corpus is assembled like
a template product, not a cast: **tier_guidance opens with the identical sentence in
all 89 files** (per-tier boilerplate), **88 of 89 files restate the agenda inside
tier_guidance**, 20 files have run-on sentence joins that read as typos in the
system-prompt identity block, and every senior/principal description is under 200
characters. And the reported bug is real and structural: the Mechanical Keyboard
Enthusiast *cannot* answer a football question without keyboards, because all eight
content fields funnel to keyboards and no sentence anywhere permits anything else.
That is not a model failure. It is the prompt working as written.

**Overall grade: C−.** Per-tier grades and the route to A are in §2 and §7.

---

## 2. Grade report

| Tier | Files | Grade | Verdict |
|---|---|---|---|
| civilian | 40 | **C−** | Strongest voices, worst hobby-trap; all 40 share one identical tier_guidance opening |
| junior | 15 | **C** | Good deliberation attitudes, but 8/15 have run-on typos and most are role-labels, not lenses |
| mid | 14 | **B−** | Best tier: method lenses (data, SRE-shaped thinking) transfer across topics |
| senior | 11 | **C+** | Good anti-patterns, thin identity text (avg 156 chars), boilerplate guidance |
| principal | 9 | **C+** | CFO is a standout; the rest are thin and the tier is missing three obvious seats |
| **Overall** | **89** | **C−** | A template product with good bones, not a cast |

---

## 3. The keyboard problem — root cause, field by field

`personas/civilian/mechanical-keyboard-enthusiast.json`, current state:

| Field | Text | Permits non-keyboard content? |
|---|---|---|
| persona | Cherry MX Brown vs Zealio V2, actuation force… | No |
| agenda | hyper-niche ergonomics, switch feedback… | No |
| tier_guidance | "Through mechanical keyboards: translate …" | Explicitly **no** — commands translation *into* keyboards |
| reflection_guidance | "Rehearse through mechanical keyboards lens" | No |
| anti-patterns (×3) | membrane keyboards, Cherry MX Browns… | No |
| communication_style | force curves, sound frequency… | No |

Score: **0 of 8 fields** allow a general contribution. On a football question the
model has two compliant options: force the analogy or pass. It usually forces the
analogy, because the WHEN TO PASS rules discourage passing when "your expertise
angle" is uncovered — and keyboards are never covered by football. The system is
doing exactly what the files say. Four civilian files make it explicit in style
(`competitive-esports-coach`, `freelance-event-photographer`,
`off-grid-digital-nomad`, `suburban-parent-of-three`): "Frames **everything** in
terms of X." That sentence is the bug in miniature.

The civilian template doubles it: all 40 files open tier_guidance with the identical
"test the proposal against a real Tuesday in your world" and close reflection with
"End with 'On my Tuesday this means …'". A Tuesday test is a fine *budget* (one
analogy per turn). As written it is a *mandate* (every turn, every topic).

---

## 4. Findings

### F1 [structural] tier_guidance is 100% boilerplate + agenda restatement
Openings are identical within tier: junior 15/15 ("surface one concrete
example…"), mid 14/14 ("make one tradeoff explicit…"), senior 11/11 ("name the
irreversible commitment…"), civilian 40/40 ("test the proposal against a real
Tuesday…"), principal 8/9. The tier half duplicates `blocks.js` doctrine; the
remainder restates the agenda — measured: the agenda's first sentence reappears
in tier_guidance in **88 of 89 files** (e.g. "Your security test: identify
security implications of every proposal" = the agenda verbatim). Net new
information per file: roughly one domain clause. The field costs ~270 chars/turn
to restate what two other prompt locations already say.

### F2 [correctness] 20 files have run-on sentence joins
Template concatenation without terminal punctuation, e.g.:
- `skeptical-optimizer` persona: "…failure modes You ask what fails first…"
- `data-scientist` persona: "…correlation vs causation You separate correlation…"
- `fresh-eyes` persona: "…superpower Your distance is the value…"
- `average-joe`, `budget-hawk`, `devil-s-advocate`, `ethics-checker`,
  `market-watcher`, `process-scout`, `commercial-strategist`,
  `compliance-analyst`, `marketing-strategist` (persona), and 9 more.
These render verbatim in the `## Identity` block. The cast's first impression,
in a fifth of cases, is a typo.

### F3 [depth] every senior/principal identity is under 200 chars
Senior avg 156, principal avg 160 (measured range 130–186). The Security
Engineer — a flagship seat — is two sentences (~186 chars) against a 4000-char
allowance. Thin identities produce stereotype fill: the model invents the
missing seniority. (Now surfaced at load by the `persona_thin` warning; 20
files. Warnings are not a fix — see §6.4.)

### F4 [transfer] method lenses beat hobby lenses, and the corpus knows it
The best files define a *portable method*: data-scientist ("ask denominator, N,
and time window"), crisis-risk-premortem-lead, CFO ("name the line item, the
payback period, who signs"). These work on football *and* fintech. The worst
files define a *topic*: keyboards, sound profiles, switch feedback. The corpus
has no shared rule for which kind a persona should be — so civilian seats are
topics and professional seats are methods, and off-domain questions expose the
difference every time.

### F5 [remnant] role labels still leak into expertise
P2 removed trait entries (`eager`, `inexperienced`) but `skeptical-optimizer`
still carries `"junior-engineer"` as expertise — a seniority label, not a
domain, scored by the keyword fallback and embedded in the index. One-line
fix, same class.

### F6 [coverage] the professional tiers are thin where it matters
Junior (15) is attitudes without domains; mid (14) has no SRE, data engineer,
or AppSec analyst; senior (11) has no ML, design, or delivery-through-others
seat; principal (9) has no CTO, General Counsel, or People officer. The room
composer can only seat what exists: any question about ML systems, design
systems, or org incentives gets a civilian generalist or a stretched neighbor.
§6.5 proposes 12 seats.

---

## 5. What is already strong (keep)

- Distinct voices where the author wrote freely (CFO's "state the denominator",
  premortem's "most damaging objection" lineage, the steelman-before-lens
  disposition pairing).
- The positive-form anti-pattern structure ("Never X — instead, state what you
  observed with [#id]/Source") is the right shape; keep it, vary the third slot.
- Biases are honest and specific (kid-proofing, narrative appeal, disruptive
  upside) — the lowercase migration (§P2-D) already fixed their rendering.
- Method-lens reflection closers ("End with the metric that would change your
  mind", "Settled: … Open: …") genuinely differentiate tiers.

---

## 6. Remediation — C− to A

### 6.1 The range rule (fixes the keyboard bug class, scriptable)
Bake a two-sentence range budget into the shared civilian tier_guidance opening
(one scripted edit — all 40 share the identical opening, so one replacement
fixes all 40) and mirror it in reflection closers:

> Lead with the question's own terms. Your world earns **at most one analogy
> or test per turn** — if the question has nothing to do with your domain,
> contribute the generalist move your tier expects (a naive question, a
> tradeoff, a risk) **without forcing the analogy**. A skipped analogy is
> correct behavior, not a failure to contribute.

Plus: delete the four "Frames **everything** in terms of X" style sentences
(replace with "Reaches for one concrete analogy from X when it fits; otherwise
reasons in the question's own terms"). And give the Enthusiast an off-ramp in
its own tier_guidance — full rewritten exemplar:

```json
"tier_guidance": "Test the proposal against a real Tuesday in your world — time, money, safety, fatigue — but at most once per turn and only when it fits. Through mechanical keyboards is one option, not the assignment: translate “Focus on hyper-niche ergonomics, sound profiles, switch” into time, money, or risk when the question touches tools, craft, or long-horizon use; otherwise contribute the plain generalist move (a naive question, a tradeoff, a risk) in the question's own terms. You have touched physical craft — cite the material, tool, or regulation you know by feel when it applies, and stay silent about keyboards when it does not."
```

Rule of thumb for all hobby seats: **the lens is a budget, not an identity.**
Any field that says "everything", "always", or "through X" with no exit clause
is the bug.

### 6.2 De-template tier_guidance (scriptable, biggest token win)
`blocks.js` owns tier doctrine; the agenda owns the assignment. tier_guidance
should keep **only the domain-specific test** (1–2 sentences): delete the tier
boilerplate opening and any clause restating the agenda ("Your X test: …" where
X restates the agenda). Security Engineer after treatment:

> Cite a pattern you have seen — "Irreversible: … because … Mitigation: …".
> Make the security claim falsifiable and cite a [#id] if responding.

Expected saving ~150 chars × 89 files per turn, and the field becomes the only
place the domain test lives — which is what makes future edits safe.

### 6.3 Mechanical fixes (scripted, reviewable diff)
- Insert missing periods at the 20 run-on joins (§4 F2 list); add a loader
  lint for `[a-z] (You|Your) ` without terminal punctuation (same shape as the
  existing `lintPersonaStyle`).
- Remove `"junior-engineer"` from expertise (F5).
- Add a circularity lint: fail when the agenda's first 40 chars appear in
  tier_guidance (88/89 today — grandfather existing files, gate new ones, burn
  down the list with 6.2).

### 6.4 Senior/principal depth (manual authorship, the real work)
Expand all 20 sub-200-char identities to 200–400 chars of *domain specifics*:
named patterns, failure modes, numbers with units — not adjectives. Example
direction for Security Engineer: JWT revocation vs statelessness, refresh-token
rotation, OWASP categories actually invoked, one war story compressed to a
clause. This is the only remediation that cannot be scripted, and it is the
difference between B+ and A−.

### 6.5 Twelve new seats (detailed below in §7)
Fill the coverage gaps so the composer stops seating stretched neighbors. All
twelve are method lenses first, domains second — per F4, that is what transfers.

### 6.6 Lints to keep it there
`persona_thin` and `persona_style`/`persona_truncated` already warn at load.
Add: run-on detection, agenda-circularity, tier_guidance-opening uniqueness
(no two files in a tier share an opening 60 chars), and a "range rule present"
check for civilian files (must contain "at most one" or equivalent). Extend
`test/prompt-lint.test.js` test 7 to assert zero warnings — corpus regressions
then fail CI instead of waiting for a football question.

---

## 7. New persona proposals

Design rule applied throughout: **method first, domain second, exit clause
always.** Each sketch gives the transferable move plus the one analogy it owns.

### Junior (attitudes + a first domain each)

| # | Name | Pitch | Transferable move | Owns one analogy from |
|---|---|---|---|---|
| J1 | Customer Support Triager | Has read 10,000 tickets; knows where users actually break | "Show me the ticket": demands the concrete failure report behind every abstraction | support queues, repro steps |
| J2 | First-Year Apprentice | Six months in; asks for definitions without shame | Jargon audit: "what does that word mean here?" exposes hand-waving | onboarding docs, tutorial gaps |
| J3 | Side-Project Hacker | Ships weekend prototypes; cheapest-test instinct | "What's the 2-hour version?": forces the smallest falsifiable slice | prototypes, throwaway builds |

### Mid (missing engineering functions)

| # | Name | Pitch | Transferable move | Owns one analogy from |
|---|---|---|---|---|
| M1 | Site Reliability Engineer | Lives by SLOs and error budgets | "What's the budget?": converts reliability vibes into burn-rate numbers | incidents, postmortems, SLOs |
| M2 | Data Engineer | Owns pipelines; schema-contract thinker | "What breaks upstream?": traces every claim to its source contract | pipelines, schemas, backfills |
| M3 | Developer Experience Engineer | Serves other engineers; friction hunter | "How long does the loop take?": measures feedback latency of any process | tooling, docs, onboarding |

### Senior (missing depth)

| # | Name | Pitch | Transferable move | Owns one analogy from |
|---|---|---|---|---|
| S1 | Staff ML Engineer | Has watched models fail silently in prod | "How would we know it's wrong?": evals, drift, silent-failure instrumentation | model evals, training/serving skew |
| S2 | Senior Product Designer | Systems thinker beyond the brand lens | "Show me the unhappy path": edge states, empty states, error states | design systems, usability debt |
| S3 | Team Lead (Player-Coach) | Delivers through others; code-review lens | "Who owns the follow-through?": names the DRI and the review that catches regressions | reviews, ownership, mentoring |

### Principal (missing C-suite breadth)

| # | Name | Pitch | Transferable move | Owns one analogy from |
|---|---|---|---|---|
| P1 | Chief Technology Officer | Portfolio view: build/buy/bet across tech | "What option does this foreclose?": reversibility at portfolio scale | platform bets, technical debt |
| P2 | General Counsel | Liability and exposure lens | "What happens in discovery?": writes the hostile-deposition version of every commitment | contracts, regulators, precedent |
| P3 | Chief People Officer | Org design and incentives lens | "What behavior does this reward?": reads every proposal as an incentive change | hiring bars, comp, culture |

### Worked example (J1, full draft shape)

```json
{
  "name": "Customer Support Triager",
  "persona": "You have read ten thousand support tickets, and you know that users break products in ways no test plan predicts. You trust the ticket queue over the roadmap: if three strangers hit the same wall, the wall is the feature.",
  "agenda": "Surface the concrete failure report behind every abstraction. Ask what the user sees, clicks, and loses.",
  "expertise": ["support-operations", "failure-reports", "reproduction-steps", "user-friction"],
  "known_biases": ["over-weights anecdote volume vs severity", "assumes the loudest tickets represent everyone", "may resist elegant designs that confuse novices"],
  "communication_style": "Concrete and user-voiced. Quotes the ticket ('user tried X, saw Y') before theorizing.",
  "preferred_contribution_types": ["question", "challenge", "refine"],
  "reflection_guidance": "Replay through the queue lens: which ticket does this resemble? End with the repro step that would prove you wrong.",
  "tier_guidance": "Surface one ticket-shaped question seniors take for granted ('what does the user see when this fails?'). At most one queue analogy per turn; on unfamiliar domains, ask the naive observability question in the question's own terms.",
  "anti_patterns": ["Never say 'users will figure it out' — instead, state what you observed with a [#id] or Source and a falsifiable scenario.", "Do not cite ticket volume without severity — instead, ground your move with a [#id] or Source and one falsifiable test.", "Avoid designing for yourself — instead, offer the concrete alternative with evidence."],
  "tags": ["support operations", "user friction", "failure reports", "observability"],
  "version": "1.0"
}
```

Note the exit clause inside tier_guidance ("on unfamiliar domains… in the
question's own terms") — that sentence is the keyboard fix, generalized. Every
new file carries one; the civilian template carries it 40× via §6.1.

---

## 8. Grade trajectory

| Band | Work | Expected |
|---|---|---|
| Today | — | **C−** |
| Mechanical pass (6.1 template edit + 6.3 run-ons/traits/lints) | ~half day, scripted + reviewed | **B** — hobby-trap closed at the template level; no more typos |
| + De-templating (6.2) | ~half day, scripted | **B+** — every guidance field carries signal; shorter prompts |
| + Depth + 12 seats (6.4, 6.5) | ~2 days authorship | **A−** — a real cast with coverage |
| + Lint gates (6.6) | ~half day | **A** — regressions fail CI, not football questions |

---

## 9. Implementation record (2026-09-26)

All of §6 implemented. Corpus: **89 → 101 files**, zero warnings across all
six loader lints, full suite **87/87** green, `check.mjs` + `docs-verify.mjs`
pass, render-checked (disposition, doctrine, rotation).

- **6.1** Range rule baked into the shared civilian opening (one replacement →
  all 40 files) + conditional Tuesday closers in all 40 reflection_guidance +
  4 bespoke "frames everything" style rewrites + full Enthusiast exemplar.
- **6.2** Tier boilerplate deleted per tier; shape-B keeps its domain label
  ("Apply the cost check: …"); shape-C quotes repaired
  ("Through X: translate the proposal into time, money, or risk"); 16
  truncated middles completed by hand (policy → security policy, vendo →
  vendor lock-in, …); 18 exact-duplicate clauses extended with operational
  half-sentences instead of deleted (keeps the domain signal the agenda
  doesn't operationalize).
- **6.3** Run-ons fixed (0 remaining), `junior-engineer` removed from
  expertise. New lints: `lintRunons`, `lintCircularity` (exact-duplicate
  grade), `lintRangeRule`, plus the earlier `lintDepth` — all wired as
  load-time warns.
- **6.4** All 20 senior/principal identities expanded (130–186 → 346–484
  chars; band recorded as implemented, slightly above the proposed 200–400).
  `persona_thin` warnings: 20 → 0.
- **6.5** 12 new seats authored as specified (customer-support-triager,
  first-year-apprentice, side-project-hacker, site-reliability-engineer,
  data-engineer, developer-experience-engineer, staff-ml-engineer,
  senior-product-designer, team-lead, cto, general-counsel,
  chief-people-officer). Two self-corrections during review: 5 new files had
  reintroduced old boilerplate tails ("Cite a precedent…", "State 'Settled:
  …'") — removed; every new file carries an exit clause.
- **6.6** `prompt-lint` test 7 extended to all six lints (asserts zero), plus
  7b shared-template budget (LCP ≤ 60 chars professional / ≤ 450 civilian —
  the range block is the only sanctioned template) and 7c range-rule presence.

Deliberate deviations from §6: (1) exact-duplicate clauses extended rather
than deleted (above); (2) depth band 346–484 chars vs proposed 200–400 —
specificity was worth the bytes; (3) uniqueness gate implemented as an LCP
budget rather than pairwise opening comparison, after the pairwise form proved
unable to distinguish the sanctioned range block from regressed boilerplate.

## 10. Expansion record — 40 new seats (2026-09-26)

Ten per professional tier, all distinct from existing files in method, domain,
and voice; all follow the remediated conventions (lowercase biases/types, no
doctrine prefix, no agenda restatement, exit clauses, positive-form
anti-patterns). Corpus: **101 → 141 files** (junior 28, mid 27, senior 24,
principal 22, civilian 40). All six lints: zero warnings. Full suite 87/87.

- **Junior:** accessibility-tester, community-moderator, tutorial-follower,
  sales-development-rep, test-automation-rookie, social-listening-intern,
  ai-output-rater, sourcing-rookie, retail-floor-associate,
  bootcamp-teaching-assistant.
- **Mid:** frontend-engineer, api-designer, application-security-analyst,
  product-analyst, pricing-analyst, customer-success-manager,
  network-engineer, database-administrator, content-designer, sales-engineer.
- **Senior:** performance-engineer, analytics-director, research-scientist,
  strategic-sourcing-director, corporate-development-director,
  internal-audit-director, developer-relations-director,
  customer-support-director, accessibility-director,
  quality-engineering-director.
- **Principal:** chief-marketing-officer, chief-operating-officer,
  chief-information-officer, independent-board-director, founder-ceo,
  chief-economist, chief-sustainability-officer, chief-revenue-officer,
  chief-data-officer, activist-investor.

Caught during validation: one typo introduced in
`activist-investor.json` (stray CJK character, fixed immediately — non-Latin
scan added to the verification), one pre-existing corruption in
`antique-furniture-restorer.json` ("Material and历史-driven" → "Material-
and history-driven"), and five new files reintroducing old boilerplate tails
(removed). Senior/principal newcomers all clear the 200-char depth lint.

## 11. Expansion record — 40 more seats (batch 3, 2026-09-26)

Ten more per professional tier, chosen from the remaining uncovered domain
space rather than variations on existing seats. Corpus: **141 → 181 files**
(junior 38, mid 37, senior 34, principal 32, civilian 40). Validation: six
lints zero warnings, non-Latin scan clean, no duplicate names corpus-wide, no
shared 60-char guidance openings in any professional tier, full suite 87/87,
`check.mjs` clean, spot-render confirms identity + lens + bias grammar in built
system prompts.

- **Junior (10):** localization-qa-tester, open-source-maintainer,
  executive-assistant, transcriptionist, lab-technician, grant-writer,
  event-production-coordinator, customer-onboarding-specialist,
  ux-research-recruiter, archival-fact-checker. The layer the corpus was
  missing: craft and record-keeping roles — untranslatable strings, semver
  promises, calendar economics, verbatim fidelity, protocol reproducibility,
  funder logic, run-of-show contingency, activation milestones, panel bias,
  provenance tracing.
- **Mid (10):** patent-examiner, urban-planner, actuarial-analyst,
  total-rewards-analyst, commercial-real-estate-broker,
  logistics-network-planner, insurance-claims-adjuster, epidemiologist,
  facilities-energy-manager, localization-program-manager. Method lenses
  over years and places: claim scope, physical capacity, assumptions under
  numbers, the year-five lease, network design, evidence vs pattern, causal
  inference, building load, locale launch as process.
- **Senior (10):** construction-superintendent, process-engineering-lead,
  firmware-lead, public-policy-director, tax-director,
  corporate-finance-director, workplace-strategy-director,
  learning-development-director, investor-relations-director,
  financial-crime-compliance-lead. Org depth in physical, financial, and
  regulatory domains the tier had none of: trade sequencing, process
  capability, the hardware/software boundary, the rulemaking calendar,
  defensible tax positions, capital structure, real estate vs hybrid policy,
  behavior-change measurement, disclosure discipline, financial-crime
  typologies.
- **Principal (10):** chief-medical-officer,
  chief-ethics-compliance-officer, chief-international-officer,
  chief-investment-officer, chief-ai-officer, chief-design-officer,
  nonprofit-executive-director, venture-capital-partner, financial-regulator,
  chief-real-estate-officer. The last substantive gaps in the executive set:
  clinical accountability, incentive-vs-individual ethics, geopolitical
  sequencing, institutional allocation, AI portfolio governance, design as
  organizational standard, mission-constrained finance, power-law investing,
  the enforcement counterweight, and property as five-year strategy.

Tensions deliberately preserved: property appears twice at different
altitude (workplace strategy director vs chief real estate officer, policy vs
portfolio), compliance appears three times by posture (analyst maps
requirements, financial-crime lead chases typologies, chief ethics probes
incentives), and two localization voices bracket the pipeline (QA tester at
junior, program manager at mid). These are intentional adjacency, not
duplication — each answers a different question about the same domain, and
deliberation gains from having both.

## 12. Grounding remediation — the lens is not a body (2026-09-26)

**The defect.** Batch 3 (and parts of batch 2) wrote personas whose *instruction*
fields told the agent to use a body or a device: "Run the proposal on the
cheapest supported phone", "test every flow with a screen reader running",
"Transcribe hours of audio", "Replicate one procedure", "measure the yield",
"the badge data", "cite the material, tool, or regulation you know by feel". None
of that is possible. Loom agents are text agents whose entire instrument set is
`read`, `glob`, `grep`, `websearch`, `webfetch`, allowlisted `bash` (off by
default), and the `loom_*` peer tools (`ORCHESTRATION_ARCHITECTURE.md` §20,
README §234). An unactionable instruction is worse than none: the model either
fabricates the observation or produces prose about a device it never touched.

**The scan.** `/tmp/opencode/embodied-scan.js` classified 168 hits across 83
files: A device/sensor (11), B physical execution (25), C human interaction
outside the loop (0 after review), D unverifiable-authority phrasing (40),
E rhetorical simulation (85 — allowed, e.g. "On my Tuesday this means…", "at
3am", "if this fails spectacularly", which are explicitly framed as imagination).

**The rule adopted.** Backstory may have a body ("you have watched", "in my
experience" — the contract already requires unsourced claims to be qualified).
**Instruction** fields may not. Every rewritten instruction now ends in
something the agent can actually do: read the code, cite the spec, quote the
record, name the source of the number, or say plainly that it is reasoning from
judgment.

**What changed — 51 files.**

| Seat | Was | Now |
|---|---|---|
| frontend-engineer | "Run the proposal on the cheapest supported phone" | "Price one interaction from the code: what loads, what blocks, what it costs on a slow connection" |
| accessibility-tester | "test every flow with a screen reader running" | "Audit one flow in the markup: focus order, accessible names, and which errors are announced" |
| transcriptionist | "You transcribe hours of audio" | "You work from the record — transcripts, notes, and the exact wording people chose" |
| lab-technician | "You run the protocols others designed" | "You follow the protocols… from a write-up alone you can name the steps that would not survive a stranger" |
| event-production-coordinator | "You produce live events" / "Run the proposal live" | "You run the show from behind the scenes, planning for the failure nobody rehearsed" / "Walk the run-of-show" |
| construction-superintendent | "'it is only a small change' **on site**" | "…without the sequence and who signs the delay" |
| process-engineering-lead | "Measure one process" | "Name the numbers for one process: yield, cycle time, the control limit, and the source of each" |
| workplace-strategy-director | "quotes the **badge data**" | "quotes the presence data people report" |
| retail-floor-associate | "Run the proposal on a Saturday with two callouts" | "Stress the proposal against a Saturday rush… in the plan as written" |
| 11 civilians + 17 senior/principal | "cite the material, tool, or regulation you **know by feel**" / "Cite a X pattern **you have seen**" | "cite the standard, spec, or documented source you can point to, and say plainly when you are reasoning from judgment rather than evidence" |
| urban-planner, logistics-network-planner, crisis-premortem | "**Draws** the block / the lanes" · "**Walks through** the scenario" | "**Names** the block, density, walking distance" · "**Steps through** the disaster one link at a time" |

The 7 "Live-run through X lens" civilian closers were normalized to "Read through
X lens" (the word implied an instrument).

**Permanent guard.** `lintEmbodiment` (new, in `composer/persona-loader.js`)
warns at load on: device claims (`screen reader running`, `keyboard-only`,
`badge data`, `microphone`, `smartphone`), body-only verbs in instruction fields
(`run the proposal on`, `replicate the procedure`, `transcribe hours`, `by feel`),
external-system access (`query the database`, `log in to`, `check the CRM`), and
claims in `persona`/`communication_style`. `test/prompt-lint.test.js` gained
**test 7d**, an independent forbidden-phrase list that fails CI independently of
the linter, so a fix that only edits the lint cannot hide a regression.

**Documentation.** README now carries a "the lens is not a body" section with a
four-row rewrite table and the enforcement note, so the next persona author meets
the constraint before writing rather than after review.

**Verification:** 181 personas, seven lints at zero warnings, 88/88 tests,
`check.mjs` clean, `docs-verify` passed, external-system instruction scan zero
hits, and four spot-renders confirm no embodied claim reaches a built system
prompt.

**Honest limit:** backstory in `persona` still asserts lived experience ("you
have watched", "you hold accountability"), which is standard role-play and is
governed by the contract's grounding rule (never invent tool output; qualify
unsourced claims as "in my experience"). If the team wants personas that assert
*no* experience at all, that is a different corpus design — a rewrite of the
`persona` field, not of the instructions — and worth deciding deliberately
rather than by lint.
