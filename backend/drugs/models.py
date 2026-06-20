from django.db import models


class CeilingPrice(models.Model):
    so_number = models.CharField(max_length=50)
    so_date = models.DateField(null=True, blank=True)
    medicine_name = models.CharField(max_length=500)
    dosage_form_and_strength = models.CharField(max_length=300, blank=True)
    unit = models.CharField(max_length=100, blank=True)
    ceiling_price = models.DecimalField(max_digits=12, decimal_places=6)
    wpi_rate = models.DecimalField(max_digits=8, decimal_places=6, null=True, blank=True)
    effective_from = models.DateField()
    financial_year = models.CharField(max_length=10)
    source_sheet = models.CharField(max_length=50, blank=True)
    row_number = models.PositiveIntegerField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=['medicine_name']),
            models.Index(fields=['financial_year']),
            models.Index(fields=['so_number']),
        ]

    def __str__(self):
        return f"{self.medicine_name} ({self.dosage_form_and_strength}) — {self.ceiling_price} w.e.f {self.effective_from}"


class NLEMEntry(models.Model):
    """
    A single listing from the National List of Essential Medicines (NLEM).

    Each row is one (section, medicine) listing as printed in the NLEM PDF.
    The same medicine can appear under several therapeutic categories
    (cross-listed), so `sl_no` — the document's hierarchical number
    (e.g. "1.1.1", "27.4") — is the natural key within a version.
    """
    nlem_version = models.CharField(max_length=10, default="2022")
    sl_no = models.CharField(max_length=20)
    medicine = models.CharField(max_length=500)
    category = models.CharField(max_length=300, blank=True)
    dosage_form_and_strength = models.TextField(blank=True)
    level_of_healthcare = models.CharField(max_length=20, blank=True)

    class Meta:
        verbose_name = "NLEM entry"
        verbose_name_plural = "NLEM entries"
        constraints = [
            models.UniqueConstraint(
                fields=["nlem_version", "sl_no"],
                name="unique_nlem_version_slno",
            ),
        ]
        indexes = [
            models.Index(fields=["medicine"]),
            models.Index(fields=["category"]),
            models.Index(fields=["nlem_version"]),
        ]
        ordering = ["nlem_version", "sl_no"]

    def __str__(self):
        return f"[{self.sl_no}] {self.medicine} — {self.category}"
