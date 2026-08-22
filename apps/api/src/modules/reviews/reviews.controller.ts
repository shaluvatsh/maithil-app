import { Controller, Post, Get, Param, Body, Inject } from '@nestjs/common';
import { z } from 'zod';
import { ReviewsService } from './reviews.service';
import { CurrentUser, Public } from '../auth/guards';
import type { JwtClaims } from '../auth/auth.service';

const stars = z.number().int().min(1).max(5).optional();
const SubmitReview = z.object({
  panditStars: stars,
  punctualityStars: stars,
  samagriStars: stars,
  devoteeStars: stars,
  text: z.string().max(2000).optional(),
});

@Controller('v1')
export class ReviewsController {
  constructor(@Inject(ReviewsService) private readonly reviews: ReviewsService) {}

  @Post('bookings/:id/review')
  submit(@CurrentUser() user: JwtClaims, @Param('id') id: string, @Body() raw: unknown) {
    const body = SubmitReview.parse(raw);
    return this.reviews.submit({ bookingId: id, authorId: user.sub, ...body });
  }

  @Public()
  @Get('pandits/:id/reviews')
  list(@Param('id') id: string) {
    return this.reviews.forPandit(id);
  }
}
