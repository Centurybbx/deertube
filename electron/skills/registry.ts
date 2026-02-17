import { app, shell } from "electron";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import {
  getPresetAgentSkills,
  type RuntimeAgentSkill,
} from "../../src/shared/agent-skills";

const SKILL_FILENAME = "SKILL.md";
const WALK_SKIP_DIRECTORIES = new Set(["node_modules", ".git", ".DS_Store"]);

const hasNodeErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === code;

export interface LocalAgentSkill extends RuntimeAgentSkill {
  relativePath: string;
  fullPath: string;
}

export interface LocalAgentSkillScanResult {
  directory: string;
  exists: boolean;
  scannedAt: string;
  skills: LocalAgentSkill[];
}

const BUILTIN_SEARCH_SKILL_FOLDERS: Record<string, string> = {
  "web3-investing": "search-web3-investing",
  "academic-research": "search-academic-research",
  "news-analysis": "search-news-analysis",
};

const normalizeWhitespace = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const normalizeSkillName = (value: string): string =>
  value.trim().toLowerCase();

const parseFrontmatterBlock = (raw: string): string | null => {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : null;
};

const parseFrontmatterValue = (
  block: string | null,
  key: string,
): string | undefined => {
  if (!block) {
    return undefined;
  }
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(
    new RegExp(`^\\s*${escapedKey}\\s*:\\s*(.+)\\s*$`, "mi"),
  );
  if (!match) {
    return undefined;
  }
  const rawValue = match[1]?.trim();
  if (!rawValue) {
    return undefined;
  }
  return rawValue.replace(/^["']|["']$/g, "").trim() || undefined;
};

const parseMarkdownTitle = (raw: string): string | undefined => {
  const headingLine = raw
    .split(/\r?\n/)
    .find((line) => /^#\s+/.test(line.trim()));
  if (!headingLine) {
    return undefined;
  }
  return headingLine.replace(/^#\s+/, "").trim() || undefined;
};

const parseMarkdownDescription = (raw: string): string | undefined => {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const candidate = lines.find(
    (line) =>
      !line.startsWith("#") &&
      !line.startsWith("-") &&
      !line.startsWith("*") &&
      !/^[0-9]+\./.test(line),
  );
  return candidate ? normalizeWhitespace(candidate) : undefined;
};

const parseActivationHints = (frontmatterBlock: string | null): string[] => {
  if (!frontmatterBlock) {
    return [];
  }
  const match = frontmatterBlock.match(
    /activationHints\s*:\s*\[([^\]]*)\]/im,
  );
  const activationHintBlock = match?.[1];
  if (!activationHintBlock) {
    return [];
  }
  return activationHintBlock
    .split(",")
    .map((value) => value.replace(/^["']|["']$/g, "").trim())
    .filter((value) => value.length > 0);
};

const yamlQuote = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const buildFrontmatterArray = (values: string[]): string =>
  `[${values.map((value) => yamlQuote(value)).join(", ")}]`;

const buildSkillMarkdownContent = (skill: RuntimeAgentSkill): string => {
  const title = skill.title.trim() || skill.name;
  const description =
    skill.description.trim() || `Local skill "${skill.name}"`;
  const activationHints = skill.activationHints
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const content = skill.content.trim();
  return [
    "---",
    `id: ${yamlQuote(skill.name)}`,
    `name: ${yamlQuote(title)}`,
    `description: ${yamlQuote(description)}`,
    `activationHints: ${buildFrontmatterArray(activationHints)}`,
    "---",
    "",
    content.length > 0 ? content : `# Skill: ${title}`,
    "",
  ].join("\n");
};

const resolveBuiltinSearchSkillSeeds = (): {
  folderName: string;
  skill: RuntimeAgentSkill;
}[] =>
  getPresetAgentSkills().map((skill) => ({
    folderName:
      BUILTIN_SEARCH_SKILL_FOLDERS[skill.name] ?? `search-${skill.name}`,
    skill: {
      ...skill,
      source: "local",
      isSearchSkill: true,
    },
  }));

export const ensureBuiltinSearchSkillsSeeded = async (): Promise<{
  directory: string;
  seededFolders: string[];
}> => {
  const directory = resolveSkillsDirectory();
  await fs.mkdir(directory, { recursive: true });
  const seededFolders: string[] = [];
  for (const seed of resolveBuiltinSearchSkillSeeds()) {
    const folderPath = path.join(directory, seed.folderName);
    const skillFilePath = path.join(folderPath, SKILL_FILENAME);
    let skillFileExists = false;
    try {
      const stat = await fs.stat(skillFilePath);
      skillFileExists = stat.isFile();
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) {
        skillFileExists = false;
      } else {
        throw error;
      }
    }
    if (skillFileExists) {
      continue;
    }
    await fs.mkdir(folderPath, { recursive: true });
    await fs.writeFile(
      skillFilePath,
      buildSkillMarkdownContent(seed.skill),
      "utf-8",
    );
    seededFolders.push(seed.folderName);
  }
  return {
    directory,
    seededFolders,
  };
};

export const resolveSkillsDirectory = (): string =>
  path.join(app.getPath("userData"), "skills");

const listSkillDirectories = async (rootDirectory: string): Promise<string[]> => {
  const queue: string[] = [rootDirectory];
  const skillDirectories: string[] = [];
  while (queue.length > 0) {
    const currentDirectory = queue.shift();
    if (!currentDirectory) {
      continue;
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    const hasSkillFile = entries.some(
      (entry) => entry.isFile() && entry.name === SKILL_FILENAME,
    );
    if (hasSkillFile) {
      skillDirectories.push(currentDirectory);
    }
    entries.forEach((entry) => {
      if (!entry.isDirectory()) {
        return;
      }
      if (WALK_SKIP_DIRECTORIES.has(entry.name)) {
        return;
      }
      queue.push(path.join(currentDirectory, entry.name));
    });
  }
  return skillDirectories;
};

const parseLocalSkill = async (
  rootDirectory: string,
  skillDirectory: string,
  usedNames: Set<string>,
): Promise<LocalAgentSkill | null> => {
  const skillFilePath = path.join(skillDirectory, SKILL_FILENAME);
  let rawContent: string;
  try {
    rawContent = await fs.readFile(skillFilePath, "utf-8");
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  const relativePath = path
    .relative(rootDirectory, skillDirectory)
    .replace(/\\/g, "/");
  const folderName = path.basename(skillDirectory).trim();
  if (!folderName) {
    return null;
  }
  const frontmatterBlock = parseFrontmatterBlock(rawContent);
  const frontmatterSkillId = parseFrontmatterValue(frontmatterBlock, "id");
  let skillName = frontmatterSkillId ?? folderName;
  if (!skillName.trim()) {
    skillName = folderName;
  }
  const normalizedBaseName = normalizeSkillName(skillName);
  if (usedNames.has(normalizedBaseName)) {
    const withPathName = `${folderName}-${relativePath
      .replace(/\//g, "-")
      .replace(/[^a-zA-Z0-9-_]+/g, "")
      .slice(-24)}`;
    skillName = withPathName || folderName;
  }
  const normalizedName = normalizeSkillName(skillName);
  usedNames.add(normalizedName);

  const title =
    parseFrontmatterValue(frontmatterBlock, "name") ??
    parseMarkdownTitle(rawContent) ??
    skillName;
  const description =
    parseFrontmatterValue(frontmatterBlock, "description") ??
    parseMarkdownDescription(rawContent) ??
    `Local skill from ${relativePath}.`;
  const activationHints = parseActivationHints(frontmatterBlock);
  const isSearchSkill = folderName.toLowerCase().startsWith("search-");

  return {
    name: skillName,
    title,
    description,
    activationHints,
    content: rawContent,
    source: "local",
    isSearchSkill,
    relativePath,
    fullPath: skillDirectory,
  };
};

export const scanLocalAgentSkills = async (): Promise<LocalAgentSkillScanResult> => {
  await ensureBuiltinSearchSkillsSeeded();
  const directory = resolveSkillsDirectory();
  let directoryExists = false;
  try {
    const stat = await fs.stat(directory);
    directoryExists = stat.isDirectory();
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      directoryExists = false;
    } else {
      throw error;
    }
  }

  if (!directoryExists) {
    return {
      directory,
      exists: false,
      scannedAt: new Date().toISOString(),
      skills: [],
    };
  }

  const usedNames = new Set<string>();
  const skillDirectories = await listSkillDirectories(directory);
  const skillEntries = await Promise.all(
    skillDirectories.map((skillDirectory) =>
      parseLocalSkill(directory, skillDirectory, usedNames),
    ),
  );
  const skills = skillEntries
    .filter((entry): entry is LocalAgentSkill => entry !== null)
    .sort((left, right) => {
      if (left.isSearchSkill !== right.isSearchSkill) {
        return left.isSearchSkill ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

  return {
    directory,
    exists: true,
    scannedAt: new Date().toISOString(),
    skills,
  };
};

export const openSkillsDirectoryInFileManager = async (): Promise<{
  directory: string;
  ok: boolean;
  error?: string;
}> => {
  await ensureBuiltinSearchSkillsSeeded();
  const directory = resolveSkillsDirectory();
  await fs.mkdir(directory, { recursive: true });
  const openResult = await shell.openPath(directory);
  if (openResult && openResult.trim().length > 0) {
    return {
      directory,
      ok: false,
      error: openResult,
    };
  }
  return {
    directory,
    ok: true,
  };
};
