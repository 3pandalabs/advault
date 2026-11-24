// Hands a question from the panda helper to the contact form. Session storage,
// never the URL: what people type can be personal.
const KEY = "av_contact_question";
const EVENT = "av-contact-question";

export function passQuestionToContact(question: string) {
  try {
    window.sessionStorage.setItem(KEY, question);
  } catch {
    // Private mode: the form just opens empty.
  }
  // Already on /contact: nothing remounts, so tell the form.
  window.dispatchEvent(new Event(EVENT));
}

function takeQuestion(): string | null {
  try {
    const q = window.sessionStorage.getItem(KEY);
    if (q) window.sessionStorage.removeItem(KEY);
    return q;
  } catch {
    return null;
  }
}

/** Calls back with a waiting question, now and whenever one arrives. Returns the stop function. */
export function onContactQuestion(fill: (question: string) => void): () => void {
  const check = () => {
    const q = takeQuestion();
    if (q) fill(q);
  };
  check();
  window.addEventListener(EVENT, check);
  return () => window.removeEventListener(EVENT, check);
}
