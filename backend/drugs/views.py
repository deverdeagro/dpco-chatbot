from rest_framework import viewsets
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework.filters import SearchFilter, OrderingFilter

from .models import CeilingPrice
from .serializers import CeilingPriceSerializer


class CeilingPriceViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = CeilingPrice.objects.all().order_by("medicine_name")
    serializer_class = CeilingPriceSerializer
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_fields = ["financial_year", "so_number"]
    search_fields = ["medicine_name", "dosage_form_and_strength"]
    ordering_fields = ["medicine_name", "ceiling_price", "effective_from"]
