from django.urls import path
from rest_framework_simplejwt.views import TokenRefreshView
from .views import LoginView, MeView, UserListView, UserDetailView

urlpatterns = [
    path('auth/login/', LoginView.as_view(), name='login'),
    path('auth/refresh/', TokenRefreshView.as_view(), name='token_refresh'),
    path('auth/me/', MeView.as_view(), name='me'),
    path('auth/users/', UserListView.as_view(), name='user_list'),
    path('auth/users/<int:pk>/', UserDetailView.as_view(), name='user_detail'),
]
