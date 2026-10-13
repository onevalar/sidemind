import { avatar } from "../../lib/media";

/** A reporting window the block can switch to, such as a month, a quarter or the year to date. */
export interface BudgetPeriod {
  id: string;
  /** Short label for the switch, such as "Quarter". */
  label: string;
  /** Line under the title while this window is shown, such as "Q3 2026, July to September". */
  description: string;
  /** Phrase used in sentences for screen readers, such as "in the third quarter". */
  phrase: string;
}

/** One budget line inside a department. Amounts are keyed by period id, in whole currency units. */
export interface BudgetLine {
  id: string;
  name: string;
  budget: Record<string, number>;
  actual: Record<string, number>;
}

export interface BudgetDepartment {
  id: string;
  name: string;
  /** The budget owner, shown under the department name. */
  owner: { name: string; avatar?: string };
  lines: BudgetLine[];
}

export const budgetPeriods: BudgetPeriod[] = [
  { id: "month", label: "Month", description: "September 2026", phrase: "in September" },
  { id: "quarter", label: "Quarter", description: "Q3 2026, July to September", phrase: "in the third quarter" },
  { id: "ytd", label: "Year to date", description: "January to September 2026", phrase: "so far this year" },
];

/** Monthly plan for one line: a flat or month-by-month budget and the actual spend as a share of it, January to September. */
function line(id: string, name: string, budget: number | number[], ratios: number[]): BudgetLine {
  const plan = Array.from({ length: 9 }, (_, month) => (Array.isArray(budget) ? budget[month] : budget));
  const spent = plan.map((amount, month) => Math.round((amount * ratios[month]) / 10) * 10);
  const sum = (values: number[], from: number) => values.slice(from).reduce((total, value) => total + value, 0);
  return {
    id,
    name,
    budget: { month: plan[8], quarter: sum(plan, 6), ytd: sum(plan, 0) },
    actual: { month: spent[8], quarter: sum(spent, 6), ytd: sum(spent, 0) },
  };
}

export const budgetDepartments: BudgetDepartment[] = [
  {
    id: "engineering",
    name: "Engineering",
    owner: { name: "Nathan Cole", avatar: avatar("nathan-cole") },
    lines: [
      line("eng-salaries", "Salaries and benefits", [980000, 980000, 995000, 1005000, 1005000, 1020000, 1020000, 1035000, 1035000], [.98, .97, .99, .98, .96, .97, .96, .95, .96]),
      line("eng-cloud", "Cloud infrastructure", 182000, [1.01, 1.03, 1.04, 1.06, 1.08, 1.11, 1.13, 1.16, 1.19]),
      line("eng-contractors", "Contractors", 96000, [.92, 1.08, 1.12, .88, .94, 1.02, 1.06, 1.1, .97]),
      line("eng-tools", "Software and tools", 48000, [1, 1, 1.02, 1.02, 1.03, 1.03, 1.05, 1.05, 1.06]),
      line("eng-travel", "Travel", 12000, [.62, .8, .74, 1.1, .7, .66, .58, .9, 1.24]),
    ],
  },
  {
    id: "sales",
    name: "Sales",
    owner: { name: "Tyler Hayes", avatar: avatar("tyler-hayes") },
    lines: [
      line("sales-comp", "Salaries and commissions", 612000, [.94, .97, 1.04, .96, 1, 1.07, .98, 1.02, 1.09]),
      line("sales-events", "Travel and client events", 64000, [.78, .9, 1.12, 1.05, 1.14, .96, .84, .88, 1.18]),
      line("sales-tools", "Sales tools", 38000, [1, 1, 1, 1.01, 1.01, 1.01, 1.01, 1.01, 1.01]),
      line("sales-referrals", "Partner referrals", 42000, [.6, .72, .81, .9, .77, .95, .88, 1.14, 1.26]),
    ],
  },
  {
    id: "marketing",
    name: "Marketing",
    owner: { name: "Ava Mitchell", avatar: avatar("ava-mitchell") },
    lines: [
      line("mkt-paid", "Paid acquisition", 240000, [.86, .9, .95, .92, .97, 1.01, .88, .84, .9]),
      line("mkt-salaries", "Salaries and benefits", 186000, [.99, .99, 1, 1, .98, .98, .97, .97, .97]),
      line("mkt-events", "Events and sponsorships", [60000, 60000, 90000, 60000, 60000, 110000, 60000, 60000, 140000], [.7, .82, 1.06, .74, .9, 1.02, .8, .96, .93]),
      line("mkt-content", "Content and design", 58000, [.9, .94, .88, 1.02, .97, .91, .95, .92, .89]),
      line("mkt-tools", "Marketing tools", 22000, [1, 1, 1, 1, 1.04, 1.04, 1.04, 1.04, 1.04]),
    ],
  },
  {
    id: "customer-success",
    name: "Customer success",
    owner: { name: "Hannah Walsh", avatar: avatar("hannah-walsh") },
    lines: [
      line("cs-salaries", "Salaries and benefits", 292000, [.99, 1, 1, 1.01, 1.02, 1.02, 1.03, 1.03, 1.04]),
      line("cs-onboarding", "Onboarding services", 44000, [1.1, 1.14, 1.08, 1.2, 1.16, 1.22, 1.18, 1.24, 1.29]),
      line("cs-tools", "Support tooling", 26000, [1, 1, 1, 1, 1, 1.08, 1.08, 1.08, 1.08]),
      line("cs-training", "Training", 9000, [.4, .66, .9, .52, .7, 1.1, .44, .6, .82]),
    ],
  },
  {
    id: "product",
    name: "Product and design",
    owner: { name: "Jasmine Brooks", avatar: avatar("jasmine-brooks") },
    lines: [
      line("pd-salaries", "Salaries and benefits", 342000, [.97, .98, .98, .99, .99, 1, 1, 1.01, 1.01]),
      line("pd-research", "Research panels", 18000, [.7, 1.2, .85, .9, 1.3, .6, .75, 1.1, .88]),
      line("pd-tools", "Design tools", 11000, [1, 1, 1, 1, 1, 1, .96, .96, .96]),
    ],
  },
  {
    id: "finance-legal",
    name: "Finance and legal",
    owner: { name: "Andre Williams", avatar: avatar("andre-williams") },
    lines: [
      line("fl-salaries", "Salaries and benefits", 152000, [1, 1, 1, 1, 1, 1, 1.01, 1.01, 1.01]),
      line("fl-legal", "Legal counsel", 55000, [.8, .9, 1.6, 1.2, .85, .9, 1.4, 1.1, 1.36]),
      line("fl-audit", "Audit and tax", [30000, 30000, 90000, 30000, 30000, 30000, 30000, 30000, 30000], [.9, .95, 1.12, .8, .85, .9, .92, .86, .9]),
      line("fl-insurance", "Insurance", 31000, [1, 1, 1, 1, 1, 1, 1.03, 1.03, 1.03]),
    ],
  },
  {
    id: "people",
    name: "People",
    owner: { name: "Sofia Ramirez", avatar: avatar("sofia-ramirez") },
    lines: [
      line("ppl-recruiting", "Recruiting", 68000, [.9, .82, .76, .88, .7, .64, .72, .6, .58]),
      line("ppl-offsites", "Offsites and culture", [18000, 18000, 18000, 18000, 70000, 18000, 18000, 18000, 70000], [.6, .7, .8, .5, 1.04, .7, .66, .8, 1.08]),
      line("ppl-benefits", "Benefits administration", 21000, [1, 1, 1, 1, 1, 1, 1, 1, 1]),
      line("ppl-learning", "Learning budget", 14000, [.5, .62, .8, .7, .74, .9, .66, .78, .84]),
    ],
  },
];
