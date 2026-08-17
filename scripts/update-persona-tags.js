#!/usr/bin/env node
/**
 * Updates all persona JSON files with 5 meaningful tags (space-separated words).
 * Tags summarize the persona's identity, perspective, and expertise.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const PERSONAS_DIR = join(import.meta.dirname, "..", "personas");

// Tag definitions for each persona: filename → 5 meaningful tags
const TAG_MAP = {
  // ── JUNIOR ──────────────────────────────────────────────────────────────
  "junior/average-joe.json": ["common sense", "everyday user", "practical thinking", "accessibility", "customer perspective"],
  "junior/budget-hawk.json": ["cost consciousness", "budget discipline", "financial tradeoffs", "expense tracking", "frugality"],
  "junior/creative-disruptor.json": ["creative thinking", "innovation", "lateral thinking", "cross domain ideas", "disruption"],
  "junior/curious-intern.json": ["eager learning", "fundamental questions", "fresh perspective", "inexperience", "curiosity"],
  "junior/data-metrics-specialist.json": ["data analysis", "metrics tracking", "evidence based", "analytics", "telemetry"],
  "junior/devil-s-advocate.json": ["critical thinking", "risk identification", "contrarian view", "challenge assumptions", " devil advocacy"],
  "junior/ethics-checker.json": ["ethical review", "fairness", "stewardship", "unintended consequences", "social responsibility"],
  "junior/fresh-eyes.json": ["newcomer perspective", "naive questions", "simplicity", "clarity", "first principles"],
  "junior/market-watcher.json": ["market awareness", "competitive analysis", "industry trends", "customer sentiment", "timing"],
  "junior/process-scout.json": ["process improvement", "efficiency", "automation", "workflow optimization", "operational overhead"],
  "junior/qc-edge-case-auditor.json": ["quality assurance", "edge cases", "failure modes", "boundary testing", "test coverage"],
  "junior/secops-red-teamer.json": ["offensive security", "attack vectors", "abuse cases", "threat modeling", "red teaming"],
  "junior/skeptical-optimizer.json": ["practical implementation", "skepticism", "edge cases", "feasibility", "engineering judgment"],
  "junior/storyteller.json": ["narrative craft", "communication", "human impact", "storytelling", "writing"],
  "junior/ux-ergonomics-advocate.json": ["user experience", "ergonomics", "accessibility", "cognitive load", "usability"],

  // ── MID ─────────────────────────────────────────────────────────────────
  "mid/commercial-strategist.json": ["monetization", "unit economics", "customer acquisition", "pricing strategy", "market viability"],
  "mid/compliance-analyst.json": ["regulatory compliance", "governance", "policy", "risk management", "audit"],
  "mid/data-scientist.json": ["data science", "statistics", "evidence analysis", "uncertainty quantification", "modeling"],
  "mid/ethics-ai-safety-officer.json": ["ai safety", "algorithmic bias", "ethical ai", "safety boundaries", "societal impact"],
  "mid/financial-analyst.json": ["financial modeling", "roi analysis", "cash flow", "projections", "valuation"],
  "mid/integration-systems-lead.json": ["system integration", "api design", "tech debt", "performance", "interoperability"],
  "mid/marketing-strategist.json": ["marketing strategy", "brand positioning", "messaging", "market fit", "go to market"],
  "mid/operations-lead.json": ["operations management", "execution", "logistics", "sla", "staffing"],
  "mid/product-manager.json": ["product management", "user value", "prioritization", "scope", "tradeoffs"],
  "mid/regulatory-legal-advisor.json": ["legal compliance", "data privacy", "regulation", "liability", "contract law"],
  "mid/startup-veteran.json": ["startup experience", "mvp", "speed", "pivoting", "scrappy execution"],
  "mid/systems-engineer.json": ["systems reliability", "distributed systems", "observability", "edge cases", "operations"],
  "mid/technical-writer.json": ["technical documentation", "clarity", "knowledge sharing", "onboarding", "communication"],
  "mid/ux-researcher.json": ["user research", "usability testing", "user behavior", "friction analysis", "user journey"],

  // ── SENIOR ──────────────────────────────────────────────────────────────
  "senior/change-operations-lead.json": ["change management", "organizational adoption", "implementation planning", "workflow friction", "skill development"],
  "senior/creative-director.json": ["creative direction", "brand identity", "design leadership", "visual craft", "creative strategy"],
  "senior/crisis-risk-premortem-lead.json": ["crisis planning", "pre mortem analysis", "worst case scenarios", "blast radius", "fallback protocols"],
  "senior/engineering-director.json": ["engineering leadership", "team capacity", "delivery management", "tech debt", "organizational complexity"],
  "senior/operations-director.json": ["operations leadership", "reliability", "incident management", "continuous improvement", "sla management"],
  "senior/portfolio-manager.json": ["portfolio management", "risk adjusted returns", "diversification", "asset allocation", "position sizing"],
  "senior/principal-enterprise-architect.json": ["enterprise architecture", "platform strategy", "total cost of ownership", "vendor independence", "architectural flexibility"],
  "senior/risk-officer.json": ["risk management", "tail risk", "downside scenarios", "correlation analysis", "portfolio risk"],
  "senior/security-engineer.json": ["security engineering", "threat modeling", "attack surface", "defense in depth", "incident response"],
  "senior/staff-architect.json": ["software architecture", "long term design", "maintainability", "system thinking", "evolutionary design"],
  "senior/strategy-principal.json": ["strategic thinking", "competitive advantage", "market positioning", "moats", "strategic focus"],

  // ── PRINCIPAL ───────────────────────────────────────────────────────────
  "principal/business-strategist.json": ["business strategy", "market dynamics", "value creation", "competitive dynamics", "commercial viability"],
  "principal/chief-risk-officer.json": ["enterprise risk", "resilience", "black swans", "risk intelligence", "tail risk"],
  "principal/cfo.json": ["financial leadership", "capital allocation", "roi analysis", "budget management", "financial discipline"],
  "principal/cpo.json": ["product vision", "portfolio strategy", "market positioning", "user value", "product coherence"],
  "principal/executive-advisor.json": ["executive leadership", "decision making", "organizational alignment", "stakeholder management", "strategic execution"],
  "principal/innovation-catalyst.json": ["innovation", "transformation", "future thinking", "bold moves", "disruption"],
  "principal/macro-socio-economic-futurist.json": ["macro trends", "industry disruption", "socio economic shifts", "long range planning", "regulatory forecasts"],
  "principal/technical-director.json": ["technical strategy", "innovation balance", "technical vision", "decision making", "technology leadership"],
  "principal/vp-of-operations.json": ["organizational design", "vendor management", "scaling operations", "process maturity", "operational leverage"],

  // ── CIVILIAN ────────────────────────────────────────────────────────────
  "civilian/analog-audiophile-restorer.json": ["analog audio", "component fidelity", "signal path", "material quality", "restoration craft"],
  "civilian/antique-furniture-restorer.json": ["furniture restoration", "material science", "historical fidelity", "craft preservation", "structural authentication"],
  "civilian/boutique-coffee-shop-owner.json": ["small business", "local economics", "supplier margins", "community loyalty", "foot traffic"],
  "civilian/casual-mobile-gamer.json": ["mobile gaming", "casual retention", "onboarding flow", "micro entertainment", "session design"],
  "civilian/community-garden-organizer.json": ["community organizing", "volunteer coordination", "resource sharing", "land use", "soil management"],
  "civilian/competitive-esports-coach.json": ["esports coaching", "meta strategy", "team synergy", "performance pressure", "input latency"],
  "civilian/competitive-gaming-speedrunner.json": ["speedrunning", "glitch exploitation", "frame perfect execution", "system stress", "shortcut discovery"],
  "civilian/daily-bike-commuter.json": ["cycling safety", "urban infrastructure", "micro mobility", "weather adaptation", "commute optimization"],
  "civilian/deep-sea-commercial-diver.json": ["deep sea diving", "pressure management", "safety protocols", "life support", "physical isolation"],
  "civilian/freelance-event-photographer.json": ["event photography", "client management", "equipment reliability", "deadline execution", "unpredictable conditions"],
  "civilian/frugal-college-student.json": ["budget optimization", "price sensitivity", "student life", "free tier hacking", "value assessment"],
  "civilian/gig-economy-rideshare-driver.json": ["gig economics", "platform algorithms", "urban transit", "net hourly rate", "driver safety"],
  "civilian/high-altitude-tower-climber.json": ["tower climbing", "fall protection", "weather assessment", "tool tethering", "altitude fatigue"],
  "civilian/high-school-athletics-coach.json": ["youth coaching", "adolescent development", "team motivation", "parent management", "discipline systems"],
  "civilian/historical-preservationist.json": ["historic preservation", "architectural heritage", "cultural identity", "adaptive reuse", "demolition review"],
  "civilian/hoa-board-president.json": ["hoa governance", "property aesthetics", "neighbor disputes", "communal budgets", "local rules"],
  "civilian/independent-animal-rescue-director.json": ["animal rescue", "volunteer management", "donor relations", "medical triage", "foster networking"],
  "civilian/independent-auto-mechanic.json": ["automotive repair", "diagnostics", "component wear", "design flaws", "parts availability"],
  "civilian/local-newspaper-investigative-reporter.json": ["investigative journalism", "public records", "source verification", "municipal accountability", "community reporting"],
  "civilian/local-union-shop-steward.json": ["labor rights", "workplace safety", "collective bargaining", "worker morale", "shift standards"],
  "civilian/long-haul-interstate-trucker.json": ["long haul trucking", "hours of service", "highway infrastructure", "fuel logistics", "supply chain reality"],
  "civilian/mechanical-keyboard-enthusiast.json": ["mechanical keyboards", "switch mechanics", "sound profiling", "ergonomic typing", "custom manufacturing"],
  "civilian/night-shift-convenience-clerk.json": ["night retail", "solo safety", "cash handling", "late night behavior", "neighborhood dynamics"],
  "civilian/off-grid-digital-nomad.json": ["off grid connectivity", "battery management", "solar power", "low bandwidth work", "mobile independence"],
  "civilian/off-grid-homesteader.json": ["off grid systems", "resource conservation", "self sufficiency", "solar power", "water systems"],
  "civilian/offshore-oil-rig-technician.json": ["offshore operations", "equipment durability", "corrosion management", "uptime maintenance", "remote isolation"],
  "civilian/public-branch-librarian.json": ["information access", "digital privacy", "community space", "public infrastructure", "low tech accessibility"],
  "civilian/public-transit-bus-driver.json": ["public transit", "urban navigation", "passenger management", "route timing", "vehicle operations"],
  "civilian/residential-electrician.json": ["electrical code", "load calculations", "safety hazards", "retrofitting", "circuit design"],
  "civilian/small-batch-organic-farmer.json": ["organic farming", "soil health", "weather volatility", "crop yields", "local supply"],
  "civilian/street-food-truck-operator.json": ["food truck operations", "high volume service", "municipal permits", "kitchen efficiency", "cash flow"],
  "civilian/suburban-parent-of-three.json": ["household budgeting", "child safety", "time efficiency", "family logistics", "daily convenience"],
  "civilian/tabletop-rpg-game-master.json": ["game design", "emergent systems", "player psychology", "narrative structure", "rule balance"],
  "civilian/thrift-store-reseller-flipper.json": ["resale markets", "authentication", "margin analysis", "condition grading", "market timing"],
  "civilian/ultramarathon-runner.json": ["ultra endurance", "pacing strategy", "hydration nutrition", "mental stamina", "physical limits"],
  "civilian/urban-explorer-urbex.json": ["urban exploration", "structural decay", "security patterns", "access routing", "forgotten architecture"],
  "civilian/vintage-watchmaker-horologist.json": ["horology", "micro mechanics", "material wear", "precision engineering", "mechanical longevity"],
  "civilian/volunteer-fire-captain.json": ["crisis management", "emergency response", "resource allocation", "public safety", "volunteer leadership"],
  "civilian/wildland-forest-firefighter.json": ["wildland firefighting", "fire behavior", "terrain analysis", "resource deployment", "emergency evacuation"],
  "civilian/youth-sports-league-director.json": ["youth sports", "volunteer coordination", "venue scheduling", "participant safety", "local funding"],
};

let updated = 0;
let skipped = 0;
let errors = 0;

const TIERS = ["junior", "mid", "senior", "principal", "civilian"];

for (const tier of TIERS) {
  const tierDir = join(PERSONAS_DIR, tier);
  if (!existsSync(tierDir)) continue;

  const files = readdirSync(tierDir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const filePath = join(tierDir, file);
    const key = `${tier}/${file}`;
    try {
      const raw = readFileSync(filePath, "utf-8");
      const persona = JSON.parse(raw);
      const newTags = TAG_MAP[key];

      if (!newTags) {
        console.log(`  SKIP (no tags defined): ${key}`);
        skipped++;
        continue;
      }

      if (newTags.length !== 5) {
        console.log(`  WARN (expected 5 tags): ${key} has ${newTags.length}`);
      }

      persona.tags = newTags;
      writeFileSync(filePath, JSON.stringify(persona, null, 2) + "\n");
      updated++;
      console.log(`  updated: ${key}`);
    } catch (err) {
      errors++;
      console.error(`  ERROR: ${key}: ${err.message}`);
    }
  }
}

console.log(`\nDone: ${updated} updated, ${skipped} skipped, ${errors} errors`);
