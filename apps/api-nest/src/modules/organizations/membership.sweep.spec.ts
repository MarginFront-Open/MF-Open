/**
 * Nothing may write ONE membership table on its own.
 *
 * Membership lives in three tables: `ba_member` (canonical) and the `user_organizations` and
 * `team_members` projections. Write paths sit in two apps and a shared package, and each is
 * locally reasonable; the risk is a new path that keeps one table up to date and not the others.
 *
 * The behavioural tests in `membership.spec.ts` prove the paths that exist today keep the tables
 * in step. They cannot notice a path added later (a new endpoint, a new Server Action) that
 * writes `ba_member` alone, and that path would come back green.
 *
 * So this sweep asks a structural question instead, one a new path cannot dodge by not being in a
 * test list: WHO IS ALLOWED TO WRITE A MEMBERSHIP TABLE AT ALL.
 *
 *   RULE 1 — `user_organizations` and `team_members` are PROJECTIONS. They may only be written
 *            from `packages/db/src/lib/membership.ts`, which is the one file that writes them as a
 *            pair. Any other file reaching for either is, by definition, keeping one table and
 *            not the other, so the sweep fails.
 *
 *   RULE 2 — `ba_member` is CANONICAL and is written by the service or Server Action that owns the
 *            decision (the last-owner lock has to sit next to it). Every file that writes it must
 *            appear in CANONICAL_WRITERS below, so adding one is a deliberate act with a reviewer
 *            attached.
 *
 *   RULE 3 — the same two rules, but for the ways of reaching a table that RULES 1 and 2 cannot
 *            see, because they match a Prisma DELEGATE call (`.<table>.<op>(`): raw SQL and
 *            string-keyed property access. This is not hypothetical caution — `membership.ts`
 *            itself uses `$queryRaw` against `ba_member` for the last-owner lock, so raw SQL is
 *            the shape the next engineer copies. A bulk cleanup written as
 *            `$executeRaw`DELETE FROM user_organizations ...`` passes RULES 1 and 2 green while
 *            doing precisely the thing they exist to forbid.
 *
 *   RULE 4 — every declared canonical writer that claims to keep the projections in step must
 *            actually CALL one of the shared helpers. A CANONICAL_WRITERS entry is a promise;
 *            this is the part that checks it was kept. It matches `helper(`, not the bare name,
 *            because the bare name appears in the prose above most of these call sites — a file
 *            that only mentions the helper in prose must not pass.
 *
 *   RULE 5 — a Prisma delegate may not be captured into a variable. RULES 1-3 match the table
 *            name AT the write, so `const t = db.user_organizations; t.deleteMany(...)` names it
 *            nowhere a regex can see and passes everything above. Forbidding the capture closes
 *            that escape without an AST, instead of chasing the call.
 *
 * The sweep DERIVES what is there from the source text and compares it to the declaration, so an
 * unlisted write fails loudly instead of being invisible. It is the same machinery as
 * `org-id-param.route-sweep.spec.ts` and `org-role.route-coverage.spec.ts`, and like those it
 * pins a FLOOR on what it matched — per area, so one area shrinking to nothing cannot hide behind
 * the others' totals.
 *
 * WHY IT LIVES IN api-nest'S SUITE AND SWEEPS THE DASHBOARD TOO. One declaration list beats two.
 * A per-app sweep means two copies of these rules and two allowlists, which is the same drift
 * problem one level up, and the dashboard's canonical writers have to be read against api-nest's
 * in order to make sense. `turbo test` runs this workspace on every
 * CI run, so a dashboard violation is a red build. The honest cost: a developer running ONLY
 * `npm test` inside apps/dashboard will not see this fire, and finds out at CI instead.
 *
 * WHAT THIS DOES NOT COVER, stated so it is a decision and not an oversight:
 *
 *   - Better Auth's organization plugin writes `ba_member` from inside `node_modules` — it owns
 *     that table (app/lib/auth.ts maps its `member` model to it) and mints rows on org creation
 *     and invitation acceptance. No sweep can see that. Its hooks
 *     (`apps/dashboard/app/lib/membership-hooks.ts`) write the projections for each of those.
 *   - It SKIPS SYMLINKS. `apps/dashboard/components/` is a tree of committed symlinks into
 *     `apps/dashboard/src/components/`, several of them deliberately dangling, so following them
 *     would both crash the walk and double-count. Nothing is lost: their targets live inside a
 *     swept root and are read directly.
 *   - It reads source TEXT, not an AST. RULES 3 and 5 close the escapes that are text-visible at
 *     all (raw SQL, `prisma['ba_member']`, capturing the delegate into a variable). What is left
 *     needs type information: a canonical writer that CALLS a shared helper — satisfying RULE 4 —
 *     but calls it outside the transaction it wrapped the `ba_member` write in. Only a reviewer
 *     catches that, which is why every call site in this codebase has the transaction spelled out
 *     in the comment above it.
 *   - SQL MIGRATIONS are not swept. `packages/db/prisma/migrations/*.sql` legitimately writes
 *     these tables, so a rule there
 *     would be an allowlist of every migration ever written, which is a list nobody maintains and
 *     therefore no gate at all. Migrations are one-shot, reviewed, and run under a human.
 *   - DIRECT SQL BY AN OPERATOR sits outside every rule here by construction.
 */

import * as fs from 'fs';
import * as path from 'path';

/** `<repo>/apps/api-nest/src/modules/organizations` -> `<repo>`. */
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..', '..');

/**
 * THE WHOLE REPOSITORY, not a list of directories.
 *
 * Enumerating directories would be the same failure shape as enumerating write paths: the list
 * is right on the day it is written and silently wrong afterwards. Sweeping everything costs
 * about 1,200 files and under 100ms.
 */
const SWEPT_ROOT = '.';

/**
 * Minimum source files, per area. The floors are per area ON PURPOSE: a single total lets one area
 * collapse to zero while the others carry the number. `.` is the whole-repo floor, so a walk that breaks entirely cannot pass either.
 */
const SWEPT_FLOORS: ReadonlyArray<{ dir: string; minFiles: number }> = [
  { dir: '.', minFiles: 900 },
  { dir: 'apps/api-nest/src', minFiles: 300 },
  { dir: 'apps/dashboard', minFiles: 400 },
  { dir: 'packages/db', minFiles: 30 },
];

const CANONICAL_TABLE = 'ba_member';
const PROJECTION_TABLES = ['user_organizations', 'team_members'] as const;
const ALL_MEMBERSHIP_TABLES = [CANONICAL_TABLE, ...PROJECTION_TABLES];

const WRITE_OPS = [
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
];

/** The ONE file allowed to write a projection table. Repo-relative. */
const PROJECTION_WRITER = 'packages/db/src/lib/membership.ts';

/**
 * Files allowed to write the canonical `ba_member` table, and why. Adding a file here is the
 * deliberate act the sweep is protecting: whoever adds it has to answer "and where does this path
 * keep the projections in step?" — the answer being a call into the shared membership helpers.
 *
 * `keepsProjectionsInStep: false` is for fixtures ONLY, never product code, and RULE 4 stops
 * being enforced for that file, so the reason has to carry its own weight.
 */
const CANONICAL_WRITERS: Record<string, { why: string; keepsProjectionsInStep: boolean }> = {
  'apps/api-nest/src/modules/organizations/organizations.service.ts': {
    why: 'createOrganization mints the owner row; deleteOrganization (leave-org) removes the caller.',
    keepsProjectionsInStep: true,
  },
  'apps/api-nest/src/modules/team/team.service.ts': {
    why: 'addMember / updateMemberRole / removeMember / acceptInvitation — the public team API.',
    keepsProjectionsInStep: true,
  },
  'apps/dashboard/app/actions/team.ts': {
    why:
      'addMember / updateMemberRole / removeMember — the Server Actions the dashboard Team UI ' +
      'calls. This is the SECOND team implementation; it never reaches api-nest.',
    keepsProjectionsInStep: true,
  },
};

/**
 * The shared helpers that write the projections as a pair. RULE 4 asks that a canonical writer
 * NAME one of these, not merely import `@marginfront/db` — half the codebase imports that package for
 * something else, so an import check alone would pass a path that keeps no projection in step.
 */
const MEMBERSHIP_HELPERS = [
  'writeMembershipProjections',
  'syncMembershipProjectionRole',
  'deleteMembershipProjections',
  'deleteOrganizationMembershipProjections',
  'setDefaultOrganization',
];

/**
 * Prisma escape hatches that reach a table without ever naming a delegate, so the RULE 1/RULE 2
 * pattern cannot see them. `$queryRaw` is here too: a hand-rolled READ against a projection table
 * authorizes against the wrong table.
 */
const RAW_SQL_OPS = ['$executeRawUnsafe', '$executeRaw', '$queryRawUnsafe', '$queryRaw'];

/** How far past a raw-SQL call to look for a table name. Comfortably past a multi-line query. */
const RAW_SQL_WINDOW = 600;

/**
 * The ONE file allowed to name a membership table in raw SQL or through string-keyed access, and
 * why: `countOwnersForUpdate` needs `SELECT ... FOR UPDATE`, which Prisma's delegate API cannot
 * express. Repo-relative.
 */
const RAW_SQL_ALLOWLIST = PROJECTION_WRITER;

/** Directories with no hand-written source in them, or whose source is a build of some other. */
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  '.git',
  'coverage',
  'test-results',
  'playwright-report',
]);

interface MembershipWrite {
  file: string;
  table: string;
  op: string;
}

interface MembershipBackDoor {
  file: string;
  table: string;
  how: string;
}

/**
 * Hand-written .ts/.tsx under `dir`, excluding tests and build output.
 *
 * `entry.isFile()` (not "anything that is not a directory") is load-bearing: see the symlink note
 * in the header. Both `.spec.ts` and `.test.ts` are dropped because the two apps name their tests
 * differently and a sweep that policed its own fixtures would be unusable.
 */
function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      listSourceFiles(full, out);
    } else if (
      entry.isFile() &&
      /\.tsx?$/.test(entry.name) &&
      !/\.(spec|test)\.tsx?$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Repo-relative, forward-slashed, so declarations above read the same on every platform. */
function repoRelative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

const allFiles = listSourceFiles(path.join(REPO_ROOT, SWEPT_ROOT));

/** How many swept files live under `dir`. `.` counts everything. */
function sweptFileCount(dir: string): number {
  if (dir === '.') return allFiles.length;
  const prefix = `${dir}/`;
  return allFiles.filter((file) => repoRelative(file).startsWith(prefix)).length;
}

/**
 * Every `<client>.<membership table>.<write op>(` in the swept source. The client identifier is
 * deliberately loose (`prisma`, `this.prisma`, `tx`, `db`, a destructured alias) — what matters is
 * the table and the operation.
 */
function findMembershipWrites(): MembershipWrite[] {
  const pattern = new RegExp(
    `\\.(${ALL_MEMBERSHIP_TABLES.join('|')})\\s*\\.\\s*(${WRITE_OPS.join('|')})\\s*[({]`,
    'g',
  );

  const writes: MembershipWrite[] = [];
  for (const file of allFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = repoRelative(file);
    for (const match of source.matchAll(pattern)) {
      writes.push({ file: relative, table: match[1], op: match[2] });
    }
  }
  return writes;
}

/**
 * Every reference to a membership table that RULES 1 and 2 structurally cannot see: raw SQL that
 * mentions one within `RAW_SQL_WINDOW` characters of the call, and string-keyed delegate access.
 *
 * Deliberately does NOT try to tell a raw read from a raw write. Parsing SQL out of a template
 * literal to decide that is more machinery than the rule is worth, and a raw READ of a projection
 * table is itself a bug: authorizing off `user_organizations` instead of `ba_member` locks people
 * out of their own organization.
 */
function findMembershipBackDoors(): MembershipBackDoor[] {
  const rawCall = new RegExp(
    `\\.(${RAW_SQL_OPS.map((op) => op.replace('$', '\\$')).join('|')})\\b`,
    'g',
  );
  const tableName = new RegExp(`\\b(${ALL_MEMBERSHIP_TABLES.join('|')})\\b`);
  const bracketAccess = new RegExp(
    `\\[\\s*['"\`](${ALL_MEMBERSHIP_TABLES.join('|')})['"\`]\\s*\\]`,
    'g',
  );

  const backDoors: MembershipBackDoor[] = [];
  for (const file of allFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = repoRelative(file);

    for (const match of source.matchAll(rawCall)) {
      const window = source.slice(match.index ?? 0, (match.index ?? 0) + RAW_SQL_WINDOW);
      const named = tableName.exec(window);
      if (named) backDoors.push({ file: relative, table: named[1], how: match[1] });
    }

    for (const match of source.matchAll(bracketAccess)) {
      backDoors.push({ file: relative, table: match[1], how: 'string-keyed delegate access' });
    }
  }
  return backDoors;
}

/**
 * Membership delegates bound to a name instead of called where they are read. Two shapes:
 *
 *   const t = this.prisma.user_organizations      the plain capture
 *   const { team_members } = db                   the destructure
 *
 * Both leave every subsequent write naming only the local, which RULES 1-3 cannot see. Requiring
 * `=` (or `:` inside a destructuring list) is what keeps this off the ordinary
 * `db.user_organizations.deleteMany(...)` call — there, the table is followed by a dot.
 */
function captureShapes(source: string): string[] {
  const tables = ALL_MEMBERSHIP_TABLES.join('|');
  const assignment = new RegExp(
    `[=:]\\s*[\\w$]+(?:\\??\\.[\\w$]+)*\\.(${tables})\\s*(?![.\\w$([])`,
    'g',
  );
  const destructure = new RegExp(`\\{[^{}]*\\b(${tables})\\b[^{}]*\\}\\s*=`, 'g');

  const found: string[] = [];
  for (const match of source.matchAll(assignment)) found.push(match[1]);
  for (const match of source.matchAll(destructure)) found.push(match[1]);
  return found;
}

function findDelegateCaptures(): Array<{ file: string; table: string }> {
  const captures: Array<{ file: string; table: string }> = [];
  for (const file of allFiles) {
    const relative = repoRelative(file);
    // The shared helper destructures nothing, but its own interface declares
    // `user_organizations: {...}` and `team_members: {...}` as type members, which the
    // destructure pattern reads as a capture. It is the one file allowed to name these tables
    // structurally at all.
    if (relative === PROJECTION_WRITER) continue;
    for (const table of captureShapes(fs.readFileSync(file, 'utf8'))) {
      captures.push({ file: relative, table });
    }
  }
  return captures;
}

describe('membership sweep: one canonical table, projections written as a pair', () => {
  const writes = findMembershipWrites();

  it('sweeps every area it claims to (none has silently collapsed to nothing)', () => {
    // A sweep that matches zero files passes green and proves nothing. Per-area floors, so one
    // area cannot hide behind another's total.
    const counts = SWEPT_FLOORS.map(({ dir, minFiles }) => ({
      dir,
      files: sweptFileCount(dir),
      minFiles,
    }));
    expect(counts.filter((c) => c.files < c.minFiles)).toEqual([]);
  });

  it('reaches every source directory, including scripts and every workspace', () => {
    // Pinned as its own case: a hand-written roots array limited to "the three dirs that write
    // membership today" would pass every rule
    // below over a codebase missing packages/db/scripts, apps/*/scripts and every new workspace.
    const swept = new Set(allFiles.map(repoRelative));
    expect(swept.has('packages/db/scripts/seed-pricing.ts')).toBe(true);
    expect(swept.has('packages/db/scripts/repair-unpriced-tool-children.ts')).toBe(true);
  });

  it('finds membership writes at all (the pattern is not silently matching nothing)', () => {
    expect(writes.length).toBeGreaterThanOrEqual(19);
    expect(new Set(writes.map((w) => w.table))).toEqual(new Set(ALL_MEMBERSHIP_TABLES));
  });

  it('sees the dashboard and packages/db, not just api-nest', () => {
    // A sweep whose roots drift back to api-nest only would still pass every rule below, over a
    // codebase half its size.
    expect(writes.some((w) => w.file.startsWith('apps/dashboard/'))).toBe(true);
    expect(writes.some((w) => w.file.startsWith('apps/api-nest/'))).toBe(true);
    expect(writes.some((w) => w.file.startsWith('packages/db/'))).toBe(true);
  });

  it('RULE 1: only the shared membership helper writes user_organizations or team_members', () => {
    const offenders = writes
      .filter((w) => (PROJECTION_TABLES as readonly string[]).includes(w.table))
      .filter((w) => w.file !== PROJECTION_WRITER);

    // If this fails, a code path is keeping ONE projection table and not the other — which is
    // how ba_member and user_organizations drift apart. Route the write through
    // writeMembershipProjections / syncMembershipProjectionRole / deleteMembershipProjections /
    // setDefaultOrganization instead.
    expect(offenders.map((w) => `${w.file} -> ${w.table}.${w.op}`)).toEqual([]);
  });

  it('RULE 2: every file that writes ba_member is a declared canonical writer', () => {
    const writerFiles = [
      ...new Set(writes.filter((w) => w.table === CANONICAL_TABLE).map((w) => w.file)),
    ].sort();

    // If this fails, a NEW path is creating or destroying canonical membership. Before adding it
    // to CANONICAL_WRITERS, answer the question this sweep exists to force: where does that path
    // keep user_organizations and team_members in step?
    expect(writerFiles).toEqual(Object.keys(CANONICAL_WRITERS).sort());
  });

  describe('RULE 3: raw SQL and string-keyed access cannot route around RULES 1 and 2', () => {
    const backDoors = findMembershipBackDoors();

    it('finds the raw-SQL usage it already knows about (the pattern is not dead)', () => {
      // Same reasoning as the floors above, and it has teeth here: this pattern matches ONE thing
      // in the codebase today (countOwnersForUpdate), so a regex typo would take it to zero and
      // the rule below would pass over nothing forever.
      expect(backDoors).toContainEqual({
        file: RAW_SQL_ALLOWLIST,
        table: CANONICAL_TABLE,
        how: '$queryRaw',
      });
    });

    it('no file outside the shared helper reaches a membership table this way', () => {
      const offenders = backDoors.filter((b) => b.file !== RAW_SQL_ALLOWLIST);

      // If this fails, someone reached a membership table by a route RULES 1 and 2 cannot police.
      // Raw SQL that writes one table leaves the others untouched by construction, which is the
      // same drift, reported green. Route it through the shared helper, or if
      // it genuinely needs raw SQL (a lock, a bulk operation), put it IN membership.ts next to
      // countOwnersForUpdate where the pairing is visible.
      expect(offenders.map((b) => `${b.file} -> ${b.table} via ${b.how}`)).toEqual([]);
    });
  });

  it('RULE 4: every canonical writer that claims to keep the projections in step actually does', () => {
    const broken = Object.entries(CANONICAL_WRITERS)
      .filter(([, entry]) => entry.keepsProjectionsInStep)
      .filter(([file]) => {
        const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
        // `helper(`, not `source.includes(helper)`. Every one of these files explains its
        // pairing in prose directly above the call, so a bare-name match would be satisfied by
        // the COMMENT, and a file that deleted the call and kept the paragraph would pass.
        return !MEMBERSHIP_HELPERS.some((helper) => new RegExp(`\\b${helper}\\s*\\(`).test(source));
      });

    // A CANONICAL_WRITERS entry is a promise that the path pairs its writes. This is where that
    // promise is checked — an import of '@marginfront/db' alone would not be evidence of anything,
    // since most of the codebase imports it for something else.
    expect(broken.map(([file]) => file)).toEqual([]);
  });

  describe('RULE 5: a membership delegate may not be captured into a variable', () => {
    const captures = findDelegateCaptures();

    it('would notice a capture if one appeared (the pattern is not dead)', () => {
      // This rule matches NOTHING in the codebase today, which makes it the one rule that could
      // rot to a broken regex unseen. So it is proved against a synthetic line instead of against
      // the repo — the assertion is on the matcher, not on a file that happens to exist.
      expect(captureShapes('const t = this.prisma.user_organizations\nt.deleteMany({})')).toEqual([
        'user_organizations',
      ]);
      expect(captureShapes('const { team_members } = db')).toEqual(['team_members']);
      // And it does not fire on the ordinary shape, or every file below would be an offender.
      expect(captureShapes('await tx.ba_member.delete({ where: { id } })')).toEqual([]);
    });

    it('no file captures one', () => {
      // If this fails, a write is about to happen through a name that never mentions the table,
      // which RULES 1-3 cannot see at all. Call the delegate inline — `db.user_organizations
      // .deleteMany(...)` — so the sweep can read what you are touching.
      expect(captures.map((c) => `${c.file} -> ${c.table}`)).toEqual([]);
    });
  });

  it('every declared file still exists (a stale allowlist is a hole)', () => {
    const declared = [PROJECTION_WRITER, ...Object.keys(CANONICAL_WRITERS)];
    const missing = declared.filter((file) => !fs.existsSync(path.join(REPO_ROOT, file)));

    // A renamed or deleted file leaves its entry behind, and the next file to land on that path
    // inherits a permission nobody granted it.
    expect(missing).toEqual([]);
  });
});
