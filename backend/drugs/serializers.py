from rest_framework import serializers
from .models import CeilingPrice


class CeilingPriceSerializer(serializers.ModelSerializer):
    class Meta:
        model = CeilingPrice
        fields = "__all__"
