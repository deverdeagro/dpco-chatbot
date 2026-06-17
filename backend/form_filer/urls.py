from django.urls import path
from .views import FormFiveJobCreateView, FormFiveJobDetailView, FormFiveJobContinueView

urlpatterns = [
    path('form5/jobs/', FormFiveJobCreateView.as_view(), name='form5_job_create'),
    path('form5/jobs/<int:pk>/', FormFiveJobDetailView.as_view(), name='form5_job_detail'),
    path('form5/jobs/<int:pk>/continue/', FormFiveJobContinueView.as_view(), name='form5_job_continue'),
]
