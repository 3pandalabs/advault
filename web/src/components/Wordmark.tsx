// Copied from 3pandalabs/brand's attribution/ pattern rather than imported —
// same copy-not-import convention as every other app in the org. See
// knowledge_base/branding.md.

export function WordmarkName() {
  return (
    <>
      Ad<span className="text-[#f5c242]">Vault</span>
    </>
  );
}

export function WordmarkTag() {
  return (
    <>
      <span
        aria-hidden
        className="mx-2 inline-block h-3.5 w-px translate-y-[1px] bg-current align-middle opacity-20"
      />
      <a
        href="https://3pandalabs.com"
        target="_blank"
        rel="noopener noreferrer"
        className="align-middle font-mono text-[10px] font-normal tracking-widest text-zinc-500 hover:text-zinc-300 hover:underline"
      >
        by 3PandaLabs
      </a>
    </>
  );
}

/** Full wordmark: name + attribution tag. Only use where the wordmark isn't
 * itself wrapped in a Link/anchor — otherwise the tag's <a> nests inside it.
 * Where it is (header logos that link home), compose WordmarkName inside the
 * Link and place WordmarkTag as a sibling instead. */
export function Wordmark() {
  return (
    <>
      <WordmarkName />
      <WordmarkTag />
    </>
  );
}
