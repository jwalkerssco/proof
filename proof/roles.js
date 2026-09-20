"use strict";
/* proof/roles.js -- pure module, no requires. The two session roles --
 * "proof" (merchandiser) and "proofadmin" -- and the branch gate.
 *
 * proofPathOk is kept for the tests and for any future host that mounts Proof
 * beside another app; in this standalone server every /api route already
 * carries its own requireRole, so the path fence is not consulted.
 */

const PROOF_ROLES = ["proof", "proofadmin"];
const isProofRole = (r) => r === "proof" || r === "proofadmin";
const proofSessionRole = (personRole) => (personRole === "admin" ? "proofadmin" : "proof");

const PROOF_PATH_OK = /^\/api\/(proof\/|bootstrap$|logout$)/;
function proofPathOk(p) { return PROOF_PATH_OK.test(String(p || "")); }

// v1 branch gate -- widening this to another branch is a one-line change,
// same convention as the old MERCH_BRANCHES.
const PROOF_BRANCHES = ["odessa"];
function proofBranchEnabled(b) { return PROOF_BRANCHES.indexOf(String(b || "")) !== -1; }

const PROOF_MAX_FAILED = 6;
const PROOF_LOCKOUT_MIN = 15;

module.exports = {
  PROOF_ROLES, isProofRole, proofSessionRole, PROOF_PATH_OK, proofPathOk,
  PROOF_BRANCHES, proofBranchEnabled, PROOF_MAX_FAILED, PROOF_LOCKOUT_MIN,
};
