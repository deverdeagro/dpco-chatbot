from django.contrib import admin
from .models import CeilingPrice


@admin.register(CeilingPrice)
class CeilingPriceAdmin(admin.ModelAdmin):
    list_display = ["medicine_name", "dosage_form_and_strength", "unit", "ceiling_price", "financial_year", "so_number"]
    search_fields = ["medicine_name", "dosage_form_and_strength", "so_number"]
    list_filter = ["financial_year"]
    ordering = ["medicine_name"]
