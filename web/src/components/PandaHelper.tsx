"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { matchTopics, type HelpTopic } from "@/lib/help/match";
import { passQuestionToContact } from "@/lib/help/question";
import { STARTERS, TOPICS } from "@/lib/help/topics";

// The panda chat box. Answers only from lib/help (text we wrote, no AI, nothing
// sent or stored); a question it can't answer goes to the contact form.

type Item = { from: "user"; text: string } | { from: "panda"; topic: HelpTopic; more: HelpTopic[]; asked: string } | { from: "none"; asked: string };

const byId = (id: string) => TOPICS.find((t) => t.id === id)!;
const CHIP = "rounded-full border border-amber-400/40 px-3 py-1.5 text-left text-xs text-amber-200 hover:bg-amber-400/10";
const BUBBLE = "max-w-[88%] rounded-2xl rounded-tl-sm bg-white/10 px-3 py-2 text-sm leading-relaxed text-zinc-100";

export function PandaHelper() {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const last = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    last.current?.scrollIntoView({ block: "start" });
  }, [items]);

  // Pages mid-redirect, and our own admin screens.
  if (/^\/(auth|oauth|dashboard\/admin)(\/|$)/.test(path)) return null;

  function ask(question: string, topic?: HelpTopic) {
    const asked = question.trim().slice(0, 300);
    if (!asked) return;
    const found = topic ? [topic] : matchTopics(asked, TOPICS);
    setItems((list) => [
      ...list,
      { from: "user", text: asked },
      found.length ? { from: "panda", topic: found[0]!, more: found.slice(1), asked } : { from: "none", asked },
    ]);
    setText("");
  }

  function close() {
    setOpen(false);
    launcher.current?.focus();
  }

  function contact(question: string) {
    passQuestionToContact(question);
    setOpen(false);
    router.push("/contact");
  }

  const chips = (topics: HelpTopic[]) => (
    <div className="flex flex-wrap gap-2">
      {topics.map((t) => (
        <button key={t.id} type="button" className={CHIP} onClick={() => ask(t.q, t)}>
          {t.q}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <button
        ref={launcher}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ask the AdVault panda"
        aria-expanded={open}
        className={`fixed right-4 bottom-4 z-40 size-14 overflow-hidden rounded-full border-2 border-amber-400 bg-[#fdeed6] shadow-lg shadow-black/50 transition hover:scale-105 focus-visible:ring-2 focus-visible:ring-amber-200 focus-visible:outline-none ${open ? "invisible" : ""}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/panda-helper.webp" alt="" width={56} height={56} />
      </button>
      {open ? (
        <section
          role="dialog"
          aria-label="AdVault helper"
          onKeyDown={(e) => e.key === "Escape" && close()}
          className="fixed inset-x-2 bottom-2 z-50 flex h-[min(34rem,calc(100dvh-1rem))] flex-col overflow-hidden rounded-2xl border border-white/15 bg-zinc-950 shadow-2xl shadow-black/70 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-96"
        >
          <header className="flex items-center gap-3 border-b border-white/10 bg-amber-400/10 px-4 py-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/panda-helper.webp" alt="" width={40} height={40} className="rounded-full" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-zinc-100">AdVault helper</p>
              <p className="text-xs text-zinc-400">Automatic answers about AdVault</p>
            </div>
            <button type="button" onClick={close} aria-label="Close" className="rounded-lg px-2.5 py-1 text-xl text-zinc-300 hover:bg-white/10">
              ×
            </button>
          </header>
          <div className="flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4" aria-live="polite">
            <p className={BUBBLE}>Hi! Ask me how AdVault works, or pick a question.</p>
            {items.length ? null : chips(STARTERS.map(byId))}
            {items.map((m, i) =>
              m.from === "user" ? (
                <div key={i} ref={i === items.length - 2 ? last : undefined} className="flex justify-end">
                  <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-amber-400 px-3 py-2 text-sm break-words text-zinc-950">{m.text}</p>
                </div>
              ) : m.from === "panda" ? (
                <div key={i} className="space-y-2">
                  <div className={BUBBLE}>
                    <p className="mb-1 text-xs font-semibold text-amber-200">{m.topic.q}</p>
                    <p>{m.topic.a}</p>
                  </div>
                  {m.topic.links?.length ? (
                    <div className="flex flex-wrap gap-2">
                      {m.topic.links.map((l) => (
                        <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className="rounded-full bg-amber-400 px-3 py-1.5 text-xs font-medium text-zinc-950 hover:bg-amber-300">
                          {l.label}
                        </Link>
                      ))}
                    </div>
                  ) : null}
                  {m.more.length ? chips(m.more) : null}
                  <button type="button" onClick={() => contact(m.asked)} className="text-xs text-zinc-400 underline hover:text-zinc-200">
                    Not what you asked? Send it to us
                  </button>
                </div>
              ) : (
                <div key={i} className="space-y-2">
                  <p className={BUBBLE}>I don&apos;t have an answer to that. Send it to our team and we&apos;ll reply by email.</p>
                  <button type="button" onClick={() => contact(m.asked)} className="rounded-full bg-amber-400 px-3 py-1.5 text-xs font-medium text-zinc-950 hover:bg-amber-300">
                    Send my question
                  </button>
                </div>
              ),
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(text);
            }}
            className="flex gap-2 border-t border-white/10 p-3"
          >
            <input
              ref={input}
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={300}
              aria-label="Your question"
              placeholder="Type your question"
              className="min-w-0 flex-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-base text-zinc-100 focus:border-amber-400/60 focus:outline-none sm:text-sm"
            />
            <button type="submit" className="rounded-lg bg-amber-400 px-4 text-sm font-medium text-zinc-950 hover:bg-amber-300">
              Ask
            </button>
          </form>
        </section>
      ) : null}
    </>
  );
}
