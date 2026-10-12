import { avatar } from "../../lib/media";

/** Sample copy for the hero signup block. Signups in the preview are simulated; nothing is sent. Portraits come from lib/media. */

export type HeroSignupState = "idle" | "submitting" | "error" | "success";
/** @deprecated Use HeroSignupState. */
export type HeroSignupStep = HeroSignupState;

export interface HeroSignupPerson {
  name: string;
  src: string;
}

export const heroSignupCopy = {
  title: "Close the month in an afternoon",
  description: "Tally matches every card payment to its receipt as it lands, so month end is a short review instead of a week of spreadsheets.",
  placeholder: "you@company.com",
  buttonLabel: "Join waitlist",
  shortButtonLabel: "Join",
  footnote: "One email when your invite is ready. Nothing else.",
  /** People already on the list before the visitor joins. */
  count: 1283,
  people: [
    { name: "Andre Williams", src: avatar("andre-williams") },
    { name: "Chloe Nguyen", src: avatar("chloe-nguyen") },
    { name: "Diane Foster", src: avatar("diane-foster") },
    { name: "Daniel Kim", src: avatar("daniel-kim") },
    { name: "Sofia Ramirez", src: avatar("sofia-ramirez") },
  ] satisfies HeroSignupPerson[],
};

/** Common domain typos, so the field can offer a one tap fix before the email is sent. */
export const domainFixes: Record<string, string> = {
  "gmial.com": "gmail.com", "gmal.com": "gmail.com", "gamil.com": "gmail.com", "gnail.com": "gmail.com", "gmail.co": "gmail.com", "gmail.con": "gmail.com", "gmaill.com": "gmail.com",
  "hotmial.com": "hotmail.com", "hotmal.com": "hotmail.com", "hotmail.co": "hotmail.com",
  "yahooo.com": "yahoo.com", "yaho.com": "yahoo.com", "yahoo.co": "yahoo.com",
  "outlok.com": "outlook.com", "outloo.com": "outlook.com", "outlook.co": "outlook.com",
  "iclod.com": "icloud.com", "icloud.co": "icloud.com", "icoud.com": "icloud.com",
};
