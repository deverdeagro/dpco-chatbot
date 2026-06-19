from django.contrib import admin
from .models import CeilingPrice, NLEMEntry


@admin.register(CeilingPrice)
class CeilingPriceAdmin(admin.ModelAdmin):
    list_display = ["medicine_name", "dosage_form_and_strength", "unit", "ceiling_price", "financial_year", "so_number"]
    search_fields = ["medicine_name", "dosage_form_and_strength", "so_number"]
    list_filter = ["financial_year"]
    ordering = ["medicine_name"]


@admin.register(NLEMEntry)
class NLEMEntryAdmin(admin.ModelAdmin):
    list_display = ["sl_no", "medicine", "category", "level_of_healthcare", "nlem_version"]
    search_fields = ["medicine", "category", "sl_no"]
    list_filter = ["nlem_version", "category"]
    ordering = ["nlem_version", "sl_no"]
