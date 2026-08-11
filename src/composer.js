import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(new URL(".", import.meta.url)));

function personasBasePath() {
  const candidates = [
    join(__dirname, "..", "personas", "loom"),
    join(__dirname, "..", "personas"),
    join(__dirname, "personas", "loom"),
    join(__dirname, "personas"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "domains.json"))) {
      return candidate;
    }
  }
  return candidates[0];
}

function userPersonasPath() {
  const configDir = process.env.LOOM_CONFIG_DIR || join(process.env.HOME || "/root", ".config", "opencode", "loom");
  const personasDir = join(configDir, "personas");
  if (existsSync(join(personasDir, "domains.json"))) {
    return personasDir;
  }
  return null;
}

function validatePersona(persona, tier, index) {
  const errors = [];
  if (!persona.name || typeof persona.name !== "string") errors.push(`name required`);
  if (!persona.persona || typeof persona.persona !== "string" || persona.persona.length < 50) errors.push("persona must be >50 chars");
  if (!persona.agenda || typeof persona.agenda !== "string") errors.push("agenda required");
  if (!persona.domains || (typeof persona.domains !== "string" && !Array.isArray(persona.domains))) errors.push("domain(s) required");
  if (errors.length > 0) {
    console.warn(`[Loom] Invalid persona at ${tier}[${index}]: ${errors.join(", ")}`);
    return false;
  }
  return true;
}

function normalizePersona(persona) {
  if (typeof persona.domains === "string") {
    persona.domains = [persona.domains];
  }
  persona.version = persona.version || "1.0";
  return persona;
}

function loadPersonasFromPath(base) {
  const tiers = ["junior", "mid", "senior", "principal"];
  const result = {};

  for (const tier of tiers) {
    try {
      const path = join(base, `${tier}.json`);
      const data = readFileSync(path, "utf-8");
      const raw = JSON.parse(data);
      if (!result[tier]) result[tier] = [];
      result[tier].push(
        ...raw
          .map((p, i) => {
            if (!validatePersona(p, tier, i)) return null;
            return normalizePersona(p);
          })
          .filter(Boolean)
      );
    } catch {
      if (!result[tier]) result[tier] = [];
    }
  }

  return result;
}

function loadPersonas() {
  const result = loadPersonasFromPath(personasBasePath());

  const userPath = userPersonasPath();
  if (userPath) {
    const userPersonas = loadPersonasFromPath(userPath);
    for (const [tier, personas] of Object.entries(userPersonas)) {
      if (personas.length > 0) {
        if (!result[tier]) result[tier] = [];
        const existingNames = new Set(result[tier].map((p) => p.name));
        for (const p of personas) {
          if (!existingNames.has(p.name)) {
            result[tier].push(p);
          }
        }
      }
    }
  }

  return result;
}

function loadDomainKeywords() {
  try {
    const path = join(personasBasePath(), "domains.json");
    const data = readFileSync(path, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function getPersonas() {
  return loadPersonas();
}

function getDomainKeywords() {
  return loadDomainKeywords();
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function createSeededRng(seed) {
  let state = seed;
  return function next() {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    return (state >>> 0) / 0xffffffff;
  };
}

function personaOverlap(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / Math.min(wordsA.size, wordsB.size);
}

function getPersonaDomains(persona) {
  if (Array.isArray(persona.domains)) return persona.domains;
  if (typeof persona.domains === "string") return [persona.domains];
  if (typeof persona.domain === "string") return [persona.domain];
  return ["general"];
}

function pickPersona(tier, used, domains, rng, existingPersonas) {
  const pool = getPersonas()[tier] ?? [];
  if (pool.length === 0) return null;

  let candidates = pool.filter((p) => !used.has(p.name));
  if (candidates.length === 0) {
    candidates = pool;
  }

  const weighted = candidates.map((p) => {
    let weight = 1;
    const personaDomains = getPersonaDomains(p);
    for (const pd of personaDomains) {
      if (domains.includes(pd)) {
        weight += 10;
        break;
      }
    }
    if (personaDomains.includes("general")) {
      weight += 2;
    }
    return { persona: p, weight };
  });

  const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
  let random = rng() * totalWeight;

  for (const { persona, weight } of weighted) {
    random -= weight;
    if (random <= 0) {
      if (existingPersonas && existingPersonas.length > 0) {
        const maxOverlap = Math.max(...existingPersonas.map((ep) => personaOverlap(ep, persona.persona)));
        if (maxOverlap > 0.6) {
          continue;
        }
      }
      used.add(persona.name);
      const pDomains = getPersonaDomains(persona);
      return {
        id: `${tier}_${persona.name.toLowerCase().replace(/\s+/g, "_")}`,
        name: persona.name,
        persona: persona.persona,
        agenda: persona.agenda,
        tier,
        domain: pDomains.join(", "),
        domains: pDomains,
      };
    }
  }

  const fallback = weighted[weighted.length - 1].persona;
  used.add(fallback.name);
  const pDomains = getPersonaDomains(fallback);
  return {
    id: `${tier}_${fallback.name.toLowerCase().replace(/\s+/g, "_")}`,
    name: fallback.name,
    persona: fallback.persona,
    agenda: fallback.agenda,
    tier,
    domain: pDomains.join(", "),
    domains: pDomains,
  };
}

function generateRoles(count, domains) {
  const roles = [];
  const isFinancial = domains.includes("finance");
  const isTechnical = domains.includes("engineering");
  const isCreative = domains.includes("creative");
  const isBusiness = domains.includes("business") || domains.includes("executive");

  if (count <= 3) {
    if (isFinancial) {
      roles.push("mid", "mid", "junior");
    } else if (isTechnical) {
      roles.push("mid", "junior", "junior");
    } else if (isBusiness || isCreative) {
      roles.push("mid", "mid", "junior");
    } else {
      roles.push("mid", "junior", "junior");
    }
  } else if (count <= 5) {
    if (isFinancial) {
      roles.push("principal", "senior", "mid", "mid", "junior");
    } else if (isTechnical) {
      roles.push("senior", "mid", "mid", "junior", "junior");
    } else if (isBusiness) {
      roles.push("senior", "mid", "mid", "junior", "junior");
    } else {
      roles.push("senior", "mid", "junior", "junior", "junior");
    }
  } else {
    if (isFinancial) {
      roles.push("principal", "senior", "senior", "mid", "mid", "junior", "junior");
    } else if (isTechnical) {
      roles.push("senior", "senior", "mid", "mid", "junior", "junior", "junior");
    } else {
      roles.push("senior", "mid", "mid", "junior", "junior", "junior", "junior");
    }
  }

  return roles.slice(0, count);
}

export async function detectDomainsWithLLM(question, promptFn, getModel) {
  const keywords = getDomainKeywords();
  const domainList = Object.keys(keywords).join(", ");
  const domainDescriptions = Object.entries(keywords)
    .map(([domain, kws]) => `- ${domain}: ${kws.slice(0, 5).join(", ")}...`)
    .join("\n");

  const prompt = `Analyze the following question and determine which domains it touches on.

Question: "${question}"

Available domains with example keywords:
${domainDescriptions}

Respond with ONLY a JSON array of domain names that apply. Include a domain if the question relates to any of its concepts. If none clearly apply, respond with [].

Examples:
- "How should we price our SaaS product?" → ["business", "finance"]
- "Design a new API for user authentication" → ["engineering"]
- "Plan our Q4 marketing campaign" → ["creative", "business"]
- "Should I buy GameStop stock?" → ["finance"]
- "How do we improve team culture?" → ["executive"]

JSON array:`;

  try {
    const model = getModel();
    const result = await promptFn(
      "You are a domain classification expert. Analyze questions and return relevant domains as JSON.",
      model,
      prompt,
    );

    const jsonMatch = result.match(/\[.*?\]/s);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        const validDomains = parsed.filter((d) => Object.keys(keywords).includes(d));
        if (validDomains.length > 0) return validDomains;
      }
    }
  } catch {
  }

  return detectDomainsFallback(question);
}

export function detectDomainsFallback(question) {
  const q = question.toLowerCase();
  const domainScores = [];

  for (const [domain, keywords] of Object.entries(getDomainKeywords())) {
    let score = 0;
    const matchedPhrases = new Set();

    const sortedKeywords = [...keywords].sort((a, b) => b.length - a.length);
    let remaining = q;

    for (const keyword of sortedKeywords) {
      if (keyword.length < 4 && !/^(roi|ipo|sql|nosql|qa|kpi|okr|sla)$/i.test(keyword)) {
        continue;
      }
      const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      const matches = remaining.match(regex);
      if (matches) {
        score += matches.length;
        matchedPhrases.add(keyword);
        remaining = remaining.replace(regex, " ");
      }
    }

    if (score >= 1) {
      domainScores.push({ domain, score });
    }
  }

  domainScores.sort((a, b) => b.score - a.score);
  return domainScores.map((d) => d.domain);
}

export function composeRoom(question, desiredCount, seed) {
  const domains = detectDomainsFallback(question);
  return composeRoomWithDomains(question, desiredCount, domains, seed);
}

export function composeRoomWithDomains(question, desiredCount, domains, seed) {
  const used = new Set();
  const participants = [];
  const selectedPersonas = [];

  const defaultCount = desiredCount ?? (domains.length > 0 ? 4 : 3);
  const count = Math.max(2, Math.min(7, defaultCount));

  const roles = generateRoles(count, domains);
  const effectiveSeed = seed ?? simpleHash(question);
  const rng = createSeededRng(effectiveSeed);

  for (const role of roles) {
    const p = pickPersona(role, used, domains, rng, selectedPersonas);
    if (p) {
      participants.push(p);
      selectedPersonas.push(p.persona);
    }
  }

  const estimatedRounds = 3;

  const domainStr = domains.length > 0 ? domains.join(", ") : "general";
  return {
    participants,
    estimated_rounds: estimatedRounds,
    reasoning: `${count}-person deliberation for ${domainStr} topic: ${roles.join(", ")}.`,
  };
}

export function formatRoomPreview(room) {
  const lines = [
    "## Proposed Deliberation Room",
    "",
    room.reasoning,
    "",
    "| # | Name | Tier | Domain | Agenda |",
    "|---|------|------|--------|--------|",
  ];
  room.participants.forEach((p, i) => {
    lines.push(`| ${i + 1} | ${p.name} | ${p.tier} | ${p.domain ?? "general"} | ${p.agenda} |`);
  });
  lines.push("");
  lines.push(`Estimated rounds: ${room.estimated_rounds}`);
  lines.push("");
  lines.push("To start, confirm this room or specify changes (e.g. 'add a security expert', 'use 6 participants').");
  return lines.join("\n");
}
