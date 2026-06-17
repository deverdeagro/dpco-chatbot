from rest_framework.routers import DefaultRouter
from .views import CeilingPriceViewSet

router = DefaultRouter()
router.register(r"ceiling-prices", CeilingPriceViewSet, basename="ceiling-price")

urlpatterns = router.urls
