/**
 * Firm-level knowledge. Not about any client, so it is the one layer that can
 * never contaminate a window. It still competes for budget, which is what
 * makes it interesting: a compliance policy is long, always relevant, and
 * almost never the thing the advisor needed.
 */

import type { FirmDocument } from "./shapes.ts";
import { firmDocFrom } from "./build.ts";

export const FIRM_DOCS: FirmDocument[] = [
  firmDocFrom(
    "firm_reg_bi",
    "Recommendation standard and documentation",
    "compliance",
    "2026-01-15",
    [
      "Every recommendation must be documented with the client's stated",
      "objective, the alternatives considered, and the reason the recommended",
      "option was chosen. Documentation happens at the time of the",
      "recommendation, not at review.",
      "",
      "A recommendation that conflicts with the client's current risk rating",
      "on file requires either an updated rating or a written exception,",
      "signed before execution. The rating on file is the CRM field",
      "risk_tolerance, not an advisor's recollection.",
      "",
      "Client-specific facts may only be sourced from that client's own",
      "records. Facts learned about a client on a shared thread or in a",
      "household meeting belong to the client they concern.",
    ].join("\n"),
  ),
  firmDocFrom(
    "firm_house_view",
    "House view — Q3 2026",
    "house-view",
    "2026-07-01",
    [
      "Duration: neutral. We are not extending past seven years in taxable",
      "accounts while the curve stays this flat.",
      "",
      "Equities: modest underweight to large-cap growth. We are not trimming",
      "concentrated single-stock positions on valuation alone; the tax cost",
      "usually exceeds the diversification benefit below a 25% weight.",
      "",
      "Municipals: constructive. Supply is light into the autumn.",
      "",
      "Private real estate: no change. We remain unwilling to underwrite new",
      "commercial exposure at current cap rates.",
    ].join("\n"),
  ),
  firmDocFrom(
    "firm_product_shelf",
    "Approved product shelf",
    "product",
    "2026-04-01",
    [
      "Core fixed income: NGF Intermediate Municipal, NGF Short Duration.",
      "Core equity: NGF Total Market, NGF International Developed.",
      "Tax-managed: NGF Direct Indexing (minimum $500K).",
      "Alternatives: Harbor Point-style private real estate is not on the",
      "shelf. Existing outside positions may be held and reported but not",
      "added to.",
      "",
      "Anything off-shelf requires desk approval before it is presented.",
    ].join("\n"),
  ),
  firmDocFrom(
    "firm_kyc_cadence",
    "KYC refresh cadence",
    "policy",
    "2025-09-01",
    [
      "Standard clients refresh every 24 months. Clients above $5M, clients",
      "with a trust relationship, and clients with a cross-border address",
      "refresh every 12 months.",
      "",
      "A refresh that lapses past 30 days blocks new discretionary trades.",
    ].join("\n"),
  ),
  firmDocFrom(
    "firm_meeting_protocol",
    "Meeting preparation protocol",
    "policy",
    "2026-02-20",
    [
      "Preparation for a client meeting covers: open items from the previous",
      "meeting, anything the client raised by email since, upcoming deadlines",
      "in the next 60 days, and any compliance item coming due.",
      "",
      "Household meetings are prepared per person. A joint meeting gets one",
      "preparation document per client, not one for the household.",
    ].join("\n"),
  ),
  firmDocFrom(
    "firm_gifts",
    "Gifts and entertainment",
    "compliance",
    "2024-11-01",
    [
      "The limit is $250 per client per year. Log within five business days.",
      "Tickets you attend with the client are entertainment, not a gift.",
    ].join("\n"),
  ),
];
