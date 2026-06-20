"""
Import the National List of Essential Medicines (NLEM) from the official PDF.

The NLEM PDF lays medicines out as bordered 4-column tables grouped under
27 therapeutic-category sections:

    S.No   |  Medicine  |  Level of Healthcare  |  Dosage form(s) and strength(s)

pdfplumber reads the ruling-line grid reliably, so we extract cells directly
(no LLM needed). The Section heading rows give the Category; subsection,
column-header and footnote rows are skipped. Extraction stops at the
"Alphabetical List" divider so the later Added/Deleted appendices — which
repeat the same table shape — don't get double-counted.

Usage:
    python manage.py import_nlem --file /path/to/NLEM_2022.pdf [--version 2022] [--clear] [--dry-run]
"""

import re

import pdfplumber
from django.core.management.base import BaseCommand, CommandError

from drugs.models import NLEMEntry

# Top-level section heading, e.g. "Section 1 | Medicines used in Anaesthesia".
# The number must NOT be followed by a dot, so subsection headings like
# "Section 1.4 - Muscle Relaxants" are not mistaken for a new category.
SECTION_RE = re.compile(r"^Section\s+\d+\b(?!\.)", re.IGNORECASE)
SECTION_PREFIX_RE = re.compile(r"^Section\s+\d+\s*[-|]?\s*", re.IGNORECASE)

# A data row's S.No is purely a dotted number: "1.1.1", "27.4".
SLNO_RE = re.compile(r"^\d+(?:\.\d+)+$")

# Page where the medicine tables end and the appendices begin.
DIVIDER = "Alphabetical List of Medicines in NLEM 2022"


def _flatten(value):
    """Collapse internal newlines/whitespace into single spaces."""
    return re.sub(r"\s+", " ", (value or "").replace("\n", " ")).strip()


def extract_entries(filepath):
    """
    Parse the NLEM PDF and yield dicts:
        {sl_no, medicine, level, category, dosage_form_and_strength}
    """
    entries = []
    current_category = None

    with pdfplumber.open(filepath) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            if DIVIDER in text and entries:
                break

            for table in page.extract_tables():
                for row in table:
                    c0 = _flatten(row[0]) if len(row) > 0 else ""
                    c1 = _flatten(row[1]) if len(row) > 1 else ""
                    c2 = _flatten(row[2]) if len(row) > 2 else ""
                    c3 = (row[3] or "").strip() if len(row) > 3 else ""

                    # Section heading -> switch the active category.
                    if SECTION_RE.match(c0) and not c1:
                        current_category = SECTION_PREFIX_RE.sub("", c0).strip(" -|")
                        continue

                    # Data row -> a medicine listing.
                    if SLNO_RE.fullmatch(c0) and c1:
                        medicine = re.sub(r"\*+$", "", c1).strip()
                        dosage = "\n".join(
                            ln.strip() for ln in c3.splitlines() if ln.strip()
                        )
                        entries.append({
                            "sl_no": c0,
                            "medicine": medicine,
                            "level": c2,
                            "category": current_category or "",
                            "dosage_form_and_strength": dosage,
                        })
                    # Everything else (subsection / header / footnote / notes) is ignored.

    return entries


class Command(BaseCommand):
    help = "Import NLEM medicines from the official PDF into the database"

    def add_arguments(self, parser):
        parser.add_argument("--file", required=True, help="Path to the NLEM PDF")
        parser.add_argument("--nlem-version", default="2022", help="NLEM version tag (default: 2022)")
        parser.add_argument("--clear", action="store_true",
                            help="Delete existing entries for this version before import")
        parser.add_argument("--dry-run", action="store_true",
                            help="Parse and report counts without writing to the database")

    def handle(self, *args, **options):
        filepath = options["file"]
        version = options["nlem_version"]

        try:
            entries = extract_entries(filepath)
        except FileNotFoundError:
            raise CommandError(f"File not found: {filepath}")

        if not entries:
            raise CommandError(
                "No NLEM entries were parsed — is this the right PDF? "
                "Expected the sectioned medicine tables of NLEM."
            )

        categories = {e["category"] for e in entries}
        sl_nos = [e["sl_no"] for e in entries]
        dupes = {n for n in sl_nos if sl_nos.count(n) > 1}

        self.stdout.write(
            f"Parsed {len(entries)} entries across {len(categories)} categories "
            f"({len(set(sl_nos))} distinct S.No)."
        )
        if dupes:
            self.stdout.write(self.style.WARNING(
                f"Duplicate S.No values found (will violate unique constraint): {sorted(dupes)}"
            ))

        if options["dry_run"]:
            self.stdout.write(self.style.SUCCESS("Dry run — no records written."))
            return

        if options["clear"]:
            deleted, _ = NLEMEntry.objects.filter(nlem_version=version).delete()
            self.stdout.write(f"Cleared {deleted} existing entries for version {version}.")

        records = [
            NLEMEntry(
                nlem_version=version,
                sl_no=e["sl_no"],
                medicine=e["medicine"],
                category=e["category"],
                dosage_form_and_strength=e["dosage_form_and_strength"],
                level_of_healthcare=e["level"],
            )
            for e in entries
        ]
        NLEMEntry.objects.bulk_create(records)

        self.stdout.write(self.style.SUCCESS(
            f"Imported {len(records)} NLEM {version} entries."
        ))
