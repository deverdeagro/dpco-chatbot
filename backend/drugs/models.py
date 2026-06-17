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
