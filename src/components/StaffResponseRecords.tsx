"use client";

import React, { useEffect, useRef, useState } from "react";
import type { BilingualDisplayPhrase } from "@/client/phrases";
import { STAFF_RESPONSE_MESSAGES } from "@/client/staffResponseMessages";
import { ANSWER_VALUES, type StaffAnswers } from "@/client/staffResponseStorage";
import { browserResponseRuntime, createStaffResponseSession } from "@/client/staffResponseCoordinator";
import styles from "./AllergyBridgeApp.module.css";

type Props = {
  context: string;
  questions: readonly BilingualDisplayPhrase[];
  userLang: string;
  storeLang: string;
  enabled: boolean;
};

/** Parent keys this component by the full in-memory context, clearing state before paint on changes. */
export function StaffResponseRecords({ context, questions, userLang, storeLang, enabled }: Props) {
  const m = STAFF_RESPONSE_MESSAGES[userLang === "ja" ? "ja" : "en"];
  const [answers, setAnswers] = useState<StaffAnswers>({});
  const [consent, setConsent] = useState(false);
  const [restoreConsent, setRestoreConsent] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [readyRevision, setReadyRevision] = useState<number | null>(null);
  const ready = readyRevision !== null;
  const session = useRef<ReturnType<typeof createStaffResponseSession> | null>(null);
  const operation = useRef(0);
  useEffect(() => {
    const current = createStaffResponseSession(browserResponseRuntime(), {
      reset: () => {
        operation.current += 1;
        setAnswers({});
        setConsent(false);
        setRestoreConsent(false);
        setBusy(false);
        setReadyRevision(null);
        setStatus(m.invalidated);
      },
      ready: (revision) => setReadyRevision(revision),
      result: (result) => {
        if (result.status === "restored" && result.answers) setAnswers(result.answers);
        setStatus(m[result.status]);
      },
    });
    session.current = current;
    void current.initialize();
    return () => { operation.current += 1; current.close(); session.current = null; };
  }, [m]);
  const questionIds = questions.map((question) => question.id);
  const recorded = Object.keys(answers).length;

  const persist = async (action: "save" | "restore") => {
    if (busy || !ready || !enabled || (action === "save" ? !consent : !restoreConsent)) return;
    const ticket = ++operation.current;
    setBusy(true);
    try {
      await session.current?.persist(action, context, answers, questionIds, action === "save" ? consent : restoreConsent, readyRevision);
    } finally {
      if (ticket === operation.current) setBusy(false);
    }
  };

  return (
    <section className={styles.cardGroupBlock} aria-labelledby="staff-records-title" data-testid="staff-records">
      <h3 id="staff-records-title" className={styles.cardGroupTitle}>{m.title}</h3>
      <p id="staff-records-notice" role="note">{m.notice}</p>
      <p className={styles.fieldHelp}>{m.highlight}</p>
      <p role="status" aria-live="polite" data-testid="staff-records-progress">
        {m.progress(recorded, questions.length, Object.values(answers).filter((answer) => answer === "unknown").length)}
      </p>
      {questions.map((question) => (
        <fieldset key={question.id} className={styles.responseQuestion} disabled={!enabled || busy} aria-describedby="staff-records-notice">
          <legend>
            <span lang={storeLang}>{question.storeText}</span><br />
            <span lang={userLang}>{question.userText}</span>
          </legend>
          <p data-testid={`record-value-${question.id}`}>{answers[question.id] ? m[answers[question.id]!] : m.unrecorded}</p>
          <div className={styles.responseChoices}>
            {ANSWER_VALUES.map((value) => (
              <label key={value} className={styles.responseChoice}>
                <input type="radio" name={`response-${question.id}`} value={value}
                  checked={answers[question.id] === value}
                  data-testid={`record-${question.id}-${value}`}
                  onChange={() => {
                    setAnswers((previous) => ({ ...previous, [question.id]: value }));
                    setStatus(m.changed);
                  }} />
                {m[value]}
              </label>
            ))}
          </div>
          <button type="button" className={styles.smallBtn} disabled={!answers[question.id]}
            data-testid={`record-clear-${question.id}`} onClick={() => {
              setAnswers((previous) => {
                const next = { ...previous };
                delete next[question.id];
                return next;
              });
              setStatus(m.changed);
            }}>{m.clear}</button>
        </fieldset>
      ))}
      <p className={styles.fieldHelp}>{m.storageHelp}</p>
      <p role="note" data-testid="record-upgrade-notice">{m.upgradeNotice}</p>
      <label className={styles.responseConsent}>
        <input type="checkbox" checked={consent} disabled={busy || !ready} data-testid="record-save-consent"
          onChange={(event) => setConsent(session.current?.authorize("save", event.target.checked, readyRevision) ?? false)} />{m.consent}
      </label>
      <button type="button" className={styles.secondaryBtn} disabled={!enabled || !ready || busy || !consent || !recorded}
        data-testid="record-save" onClick={() => void persist("save")}>{m.save}</button>
      <label className={styles.responseConsent}>
        <input type="checkbox" checked={restoreConsent} disabled={busy || !ready} data-testid="record-restore-consent"
          onChange={(event) => setRestoreConsent(session.current?.authorize("restore", event.target.checked, readyRevision) ?? false)} />{m.restoreConsent}
      </label>
      <div className={styles.actionRow}>
        <button type="button" className={styles.secondaryBtn} disabled={!enabled || !ready || busy || !restoreConsent}
          data-testid="record-restore" onClick={() => void persist("restore")}>{m.restore}</button>
        <button type="button" className={styles.secondaryBtn} data-testid="record-delete-all" onClick={() => {
          void session.current?.deleteAll();
        }}>{m.clearAll}</button>
      </div>
      <p role="status" aria-live="polite" data-testid="record-storage-status">{status}</p>
    </section>
  );
}
