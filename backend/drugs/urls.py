from django.urls import path
from rest_framework.routers import DefaultRouter
from .views import CeilingPriceViewSet
from .report_views import (
    ReportCreateView, ReportDetailView, ReportDownloadView, ReportChatView,
)

router = DefaultRouter()
router.register(r"ceiling-prices", CeilingPriceViewSet, basename="ceiling-price")

urlpatterns = router.urls + [
    path("reports/", ReportCreateView.as_view(), name="report-create"),
    path("reports/<int:pk>/", ReportDetailView.as_view(), name="report-detail"),
    path("reports/<int:pk>/download/", ReportDownloadView.as_view(), name="report-download"),
    path("reports/<int:pk>/chat/", ReportChatView.as_view(), name="report-chat"),
]
